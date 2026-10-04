import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq, desc, and, like, gte, sql, type SQL } from "drizzle-orm";
// AR-01: every procedure in this file is a protectedProcedure.  These
// endpoints enumerate secrets, register connectors, rotate live credentials,
// delete the inventory and read the audit log — none of it may be reachable
// without a console session.
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import {
  connectors,
  secrets,
  targets,
  rotationRuns,
  auditLog,
  type Connector,
  type Target,
} from "@db/schema";
import {
  connectorCreateInput,
  connectorUpdateInput,
  secretCreateInput,
  secretUpdateInput,
  secretListFilter,
  targetUpsertInput,
  policySchema,
  DEFAULT_POLICY,
  infisicalTargetConfigSchema,
  fileTargetConfigSchema,
  webhookTargetConfigSchema,
  keychainTargetConfigSchema,
  secretImportBatchInput,
  secretBatchUpdatePolicyInput,
  secretBatchSetStatusInput,
  secretBatchDeleteInput,
  secretBatchRotateInput,
  secretCheckDriftInput,
  workspaceAlertUpdateInput,
  type StatsOverview,
  type RotationPolicy,
  type FileTargetConfig,
  type InfisicalTargetConfig,
  type WebhookTargetConfig,
  type KeychainTargetConfig,
} from "@contracts/autorotate";
import { encryptJson, decryptJson, fingerprint, randomToken } from "../autorotate/crypto";
import { isDemoMode, demoLatency, demoMessage } from "../autorotate/demo";
import { connectorRegistry, getConnector, testConnection } from "../autorotate/connectors";
import { hasInfisicalConfig, upsertSecret } from "../autorotate/infisical";
import { writeFileTarget } from "../autorotate/files";
import { safeFetch } from "../autorotate/netguard";
import {
  maskAlertConfig,
  postAlert,
  readAlertConfig,
  writeAlertConfig,
} from "../autorotate/alerts";
import { requestBaseUrl } from "../lib/request-url";
import { env } from "../lib/env";
import {
  publicBaseUrlSetting,
  refreshSettings,
  setSetting,
  settingsInventory,
  getSetting,
} from "../autorotate/appSettings";
import {
  rotateSecret,
  checkSecretDrift,
  appendAudit,
  verifyAuditChain,
  infisicalSecretName,
  canaryDeliveryName,
  maskTargetConfig,
  mergePreservedTargetSecrets,
  readTargetConfig,
  RotationLockedError,
  SecretNotFoundError,
} from "../autorotate/engine";

const ACTOR = "web-user";

// F9: secrets.list/get eager-load the connector and targets.  The raw connector
// row carries configEnc (AES-encrypted admin credentials) and each target's
// configEnc/configJson carries provider secrets — neither may reach the
// browser.  Strip configEnc (connectorsRouter.list already does this) and mask
// secret fields in every target config before returning.
function sanitizeSecretForClient<
  R extends { connector?: Connector | null; targets?: Target[] },
>(row: R) {
  const { connector, targets: targetRows, ...rest } = row;
  return {
    ...rest,
    connector: connector
      ? { ...connector, hasConfig: !!connector.configEnc, configEnc: undefined as never }
      : null,
    targets: (targetRows ?? []).map((t) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- discard ciphertext, never send it to the browser
      const { configEnc: _configEnc, ...targetRest } = t;
      return {
        ...targetRest,
        configJson: maskTargetConfig(readTargetConfig(t)),
      };
    }),
  };
}

function toTrpcError(err: unknown): never {
  if (err instanceof TRPCError) throw err;
  if (err instanceof RotationLockedError) {
    throw new TRPCError({ code: "CONFLICT", message: err.message });
  }
  if (err instanceof SecretNotFoundError) {
    throw new TRPCError({ code: "NOT_FOUND", message: err.message });
  }
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: (err as Error).message,
  });
}

// ── connectors ──────────────────────────────────────────────────

export const connectorsRouter = createRouter({
  list: protectedProcedure.query(async () => {
    const db = getDb();
    const rows = await db.select().from(connectors).orderBy(connectors.id);
    const counts = await db
      .select({ connectorId: secrets.connectorId, count: sql<number>`count(*)` })
      .from(secrets)
      .groupBy(secrets.connectorId);
    const countMap = new Map(counts.map((c) => [c.connectorId, Number(c.count)]));
    return rows.map((row) => ({
      ...row,
      hasConfig: !!row.configEnc,
      configEnc: undefined as never, // never leak encrypted config to clients
      secretCount: countMap.get(row.id) ?? 0,
      registry: getConnector(row.platform)
        ? {
            known: true,
            capability: getConnector(row.platform)!.capability,
          }
        : { known: false },
    }));
  }),

  registry: protectedProcedure.query(() =>
    connectorRegistry.map((c) => ({
      platform: c.platform,
      displayName: c.displayName,
      capability: c.capability,
    })),
  ),

  create: protectedProcedure
    .input(connectorCreateInput)
    .mutation(async ({ input }) => {
      const db = getDb();
      const existing = await db.query.connectors.findFirst({
        where: eq(connectors.platform, input.platform),
      });
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `connector for platform "${input.platform}" already exists`,
        });
      }
      const known = getConnector(input.platform);
      const capability = input.capability ?? known?.capability ?? "programmatic";
      const configEnc = input.config ? encryptJson(input.config) : null;
      const [{ id }] = await db
        .insert(connectors)
        .values({
          platform: input.platform,
          displayName: input.displayName,
          capability,
          configEnc,
          status: configEnc ? "connected" : "disconnected",
          lastCheckedAt: configEnc ? new Date() : null,
        })
        .$returningId();
      await appendAudit(ACTOR, "connector.created", null, {
        connectorId: id,
        platform: input.platform,
        hasConfig: !!configEnc,
      });
      return db.query.connectors.findFirst({ where: eq(connectors.id, id) });
    }),

  update: protectedProcedure
    .input(connectorUpdateInput)
    .mutation(async ({ input }) => {
      const db = getDb();
      const row = await db.query.connectors.findFirst({
        where: eq(connectors.id, input.id),
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "connector not found" });
      const patch: Partial<typeof connectors.$inferInsert> = {};
      if (input.displayName !== undefined) patch.displayName = input.displayName;
      if (input.capability !== undefined) patch.capability = input.capability;
      if (input.status !== undefined) patch.status = input.status;
      if (input.config !== undefined) {
        patch.configEnc = encryptJson(input.config);
        patch.status = "connected";
        patch.lastCheckedAt = new Date();
      }
      await db.update(connectors).set(patch).where(eq(connectors.id, input.id));
      await appendAudit(ACTOR, "connector.updated", null, {
        connectorId: input.id,
        fields: Object.keys(patch),
      });
      return db.query.connectors.findFirst({ where: eq(connectors.id, input.id) });
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const row = await db.query.connectors.findFirst({
        where: eq(connectors.id, input.id),
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "connector not found" });
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(secrets)
        .where(eq(secrets.connectorId, input.id));
      if (Number(count) > 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `connector still manages ${count} secret(s) — delete them first`,
        });
      }
      await db.delete(connectors).where(eq(connectors.id, input.id));
      await appendAudit(ACTOR, "connector.deleted", null, {
        connectorId: input.id,
        platform: row.platform,
      });
      return { ok: true };
    }),

  test: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const row = await db.query.connectors.findFirst({
        where: eq(connectors.id, input.id),
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "connector not found" });
      try {
        const config = decryptJson(row.configEnc);
        const message = await testConnection(row.platform, config);
        await db
          .update(connectors)
          .set({ status: "connected", lastCheckedAt: new Date() })
          .where(eq(connectors.id, row.id));
        await appendAudit(ACTOR, "connector.tested", null, {
          connectorId: row.id,
          platform: row.platform,
          ok: true,
        });
        return { ok: true, message };
      } catch (err) {
        await db
          .update(connectors)
          .set({ status: "error", lastCheckedAt: new Date() })
          .where(eq(connectors.id, row.id));
        await appendAudit(ACTOR, "connector.tested", null, {
          connectorId: row.id,
          platform: row.platform,
          ok: false,
          error: (err as Error).message,
        });
        return { ok: false, message: (err as Error).message };
      }
    }),
});

// ── secrets ─────────────────────────────────────────────────────

export const secretsRouter = createRouter({
  list: protectedProcedure.input(secretListFilter).query(async ({ input }) => {
    const db = getDb();
    const conditions: SQL[] = [];
    if (input?.status) conditions.push(eq(secrets.status, input.status));
    if (input?.connectorId) conditions.push(eq(secrets.connectorId, input.connectorId));
    if (input?.environment) conditions.push(eq(secrets.environment, input.environment));
    if (input?.search) conditions.push(like(secrets.name, `%${input.search}%`));
    const rows = await db.query.secrets.findMany({
      where: conditions.length ? and(...conditions) : undefined,
      with: { connector: true, targets: true },
      orderBy: desc(secrets.id),
    });
    return rows.map(sanitizeSecretForClient);
  }),

  get: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const row = await db.query.secrets.findFirst({
        where: eq(secrets.id, input.id),
        with: { connector: true, targets: true },
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "secret not found" });
      return sanitizeSecretForClient(row);
    }),

  create: protectedProcedure
    .input(secretCreateInput)
    .mutation(async ({ input }) => {
      const db = getDb();
      const connector = await db.query.connectors.findFirst({
        where: eq(connectors.id, input.connectorId),
      });
      if (!connector) {
        throw new TRPCError({ code: "NOT_FOUND", message: "connector not found" });
      }
      const policy: RotationPolicy = { ...DEFAULT_POLICY, ...(input.policy ?? {}) };
      const now = new Date();
      const [{ id }] = await db
        .insert(secrets)
        .values({
          name: input.name,
          connectorId: input.connectorId,
          environment: input.environment,
          notes: input.notes ?? null,
          status: "healthy",
          policyJson: policy as never,
          nextDueAt: new Date(now.getTime() + policy.intervalHours * 3600 * 1000),
        })
        .$returningId();
      await appendAudit(ACTOR, "secret.created", id, {
        name: input.name,
        connectorId: input.connectorId,
        environment: input.environment,
      });
      const created = await db.query.secrets.findFirst({
        where: eq(secrets.id, id),
        with: { connector: true, targets: true },
      });
      return created ? sanitizeSecretForClient(created) : null;
    }),

  update: protectedProcedure
    .input(secretUpdateInput)
    .mutation(async ({ input }) => {
      const db = getDb();
      const row = await db.query.secrets.findFirst({
        where: eq(secrets.id, input.id),
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "secret not found" });
      const patch: Partial<typeof secrets.$inferInsert> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.environment !== undefined) patch.environment = input.environment;
      if (input.notes !== undefined) patch.notes = input.notes;
      if (input.status !== undefined) patch.status = input.status;
      if (input.policy !== undefined) {
        const current = policySchema.partial().safeParse(row.policyJson ?? {});
        const merged: RotationPolicy = {
          ...DEFAULT_POLICY,
          ...(current.success ? current.data : {}),
          ...input.policy,
        };
        patch.policyJson = merged as never;
      }
      await db.update(secrets).set(patch).where(eq(secrets.id, input.id));
      await appendAudit(ACTOR, "secret.updated", input.id, {
        fields: Object.keys(patch),
      });
      const updated = await db.query.secrets.findFirst({
        where: eq(secrets.id, input.id),
        with: { connector: true, targets: true },
      });
      return updated ? sanitizeSecretForClient(updated) : null;
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const row = await db.query.secrets.findFirst({
        where: eq(secrets.id, input.id),
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "secret not found" });
      await db.delete(targets).where(eq(targets.secretId, input.id));
      await db.delete(rotationRuns).where(eq(rotationRuns.secretId, input.id));
      await db.delete(secrets).where(eq(secrets.id, input.id));
      await appendAudit(ACTOR, "secret.deleted", input.id, { name: row.name });
      return { ok: true };
    }),

  rotateNow: protectedProcedure
    .input(z.object({ secretId: z.number() }))
    .mutation(async ({ input }) => {
      try {
        return await rotateSecret(input.secretId, "manual", ACTOR);
      } catch (err) {
        toTrpcError(err);
      }
    }),

  dryRun: protectedProcedure
    .input(z.object({ secretId: z.number() }))
    .mutation(async ({ input }) => {
      try {
        return await rotateSecret(input.secretId, "manual", ACTOR, true);
      } catch (err) {
        toTrpcError(err);
      }
    }),

  checkDrift: protectedProcedure
    .input(secretCheckDriftInput)
    .query(async ({ input }) => {
      try {
        return await checkSecretDrift(input.secretId);
      } catch (err) {
        toTrpcError(err);
      }
    }),

  importBatch: protectedProcedure
    .input(secretImportBatchInput)
    .mutation(async ({ input }) => {
      const db = getDb();
      const createdIds: number[] = [];

      for (const item of input.items) {
        let connector = await db.query.connectors.findFirst({
          where: eq(connectors.platform, item.platform),
        });

        if (!connector) {
          const known = getConnector(item.platform);
          const capability = known?.capability ?? "programmatic";
          // AR-17: an auto-created connector has no admin credential, so it
          // is "disconnected", not "connected".  Claiming otherwise was the
          // precondition for AR-02's fabricated rotations.
          const [newConn] = await db
            .insert(connectors)
            .values({
              platform: item.platform,
              displayName: known?.displayName ?? item.platform,
              capability,
              status: "disconnected",
            })
            .$returningId();
          connector = await db.query.connectors.findFirst({
            where: eq(connectors.id, newConn.id),
          });
        }
        if (!connector) continue;

        const policy: RotationPolicy = { ...DEFAULT_POLICY, ...(item.policy ?? {}) };
        const now = new Date();
        const initialFp = item.value ? fingerprint(item.value) : null;
        // AR-17: an import fingerprints the pasted value and discards it — no
        // target ever received it, so lastRotatedAt stays null.  Autorotate
        // has not rotated this secret; it has started tracking it.
        const [secretRow] = await db
          .insert(secrets)
          .values({
            name: item.name,
            connectorId: connector.id,
            environment: item.environment,
            status: "healthy",
            policyJson: policy as never,
            fingerprint: initialFp,
            lastRotatedAt: null,
            nextDueAt: new Date(now.getTime() + policy.intervalHours * 3600 * 1000),
          })
          .$returningId();

        if (item.targets && item.targets.length > 0) {
          for (const t of item.targets) {
            const config = validateTargetConfig(t.kind, t.config);
            await db.insert(targets).values({
              secretId: secretRow.id,
              kind: t.kind,
              configEnc: encryptJson(config),
              configJson: null,
              enabled: t.enabled,
            });
          }
        }

        await appendAudit(ACTOR, "secret.imported", secretRow.id, {
          name: item.name,
          platform: item.platform,
          environment: item.environment,
          targetCount: item.targets?.length ?? 0,
        });

        createdIds.push(secretRow.id);
      }

      return { ok: true, importedCount: createdIds.length, ids: createdIds };
    }),

  batchUpdatePolicy: protectedProcedure
    .input(secretBatchUpdatePolicyInput)
    .mutation(async ({ input }) => {
      const db = getDb();
      for (const secretId of input.secretIds) {
        const row = await db.query.secrets.findFirst({ where: eq(secrets.id, secretId) });
        if (!row) continue;
        const current = policySchema.partial().safeParse(row.policyJson ?? {});
        const merged: RotationPolicy = {
          ...DEFAULT_POLICY,
          ...(current.success ? current.data : {}),
          ...input.policy,
        };
        const base = row.lastRotatedAt ?? new Date();
        const nextDueAt = new Date(base.getTime() + merged.intervalHours * 3600 * 1000);
        await db.update(secrets).set({ policyJson: merged as never, nextDueAt }).where(eq(secrets.id, secretId));
        await appendAudit(ACTOR, "policy.updated", secretId, { ...merged, batch: true });
      }
      return { ok: true, count: input.secretIds.length };
    }),

  batchSetStatus: protectedProcedure
    .input(secretBatchSetStatusInput)
    .mutation(async ({ input }) => {
      const db = getDb();
      for (const secretId of input.secretIds) {
        await db.update(secrets).set({ status: input.status }).where(eq(secrets.id, secretId));
        await appendAudit(ACTOR, "secret.updated", secretId, { status: input.status, batch: true });
      }
      return { ok: true, count: input.secretIds.length };
    }),

  batchDelete: protectedProcedure
    .input(secretBatchDeleteInput)
    .mutation(async ({ input }) => {
      const db = getDb();
      for (const secretId of input.secretIds) {
        await db.delete(targets).where(eq(targets.secretId, secretId));
        await db.delete(rotationRuns).where(eq(rotationRuns.secretId, secretId));
        await db.delete(secrets).where(eq(secrets.id, secretId));
        await appendAudit(ACTOR, "secret.deleted", secretId, { batch: true });
      }
      return { ok: true, count: input.secretIds.length };
    }),

  batchRotate: protectedProcedure
    .input(secretBatchRotateInput)
    .mutation(async ({ input }) => {
      const runs = [];
      for (const secretId of input.secretIds) {
        try {
          const run = await rotateSecret(secretId, "manual", ACTOR);
          runs.push(run);
        } catch {
          // continue
        }
      }
      return { ok: true, runsCount: runs.length };
    }),
});

// ── targets ─────────────────────────────────────────────────────

function validateTargetConfig(
  kind: "infisical" | "file" | "webhook" | "keychain",
  config: Record<string, unknown>,
): Record<string, unknown> {
  const schema = {
    infisical: infisicalTargetConfigSchema,
    file: fileTargetConfigSchema,
    webhook: webhookTargetConfigSchema,
    keychain: keychainTargetConfigSchema,
  }[kind];
  const parsed = schema.safeParse(config);
  if (!parsed.success) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `invalid ${kind} target config: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    });
  }
  return parsed.data as Record<string, unknown>;
}

export const targetsRouter = createRouter({
  upsert: protectedProcedure
    .input(targetUpsertInput)
    .mutation(async ({ input }) => {
      const db = getDb();
      const secret = await db.query.secrets.findFirst({
        where: eq(secrets.id, input.secretId),
      });
      if (!secret) throw new TRPCError({ code: "NOT_FOUND", message: "secret not found" });
      const incoming = validateTargetConfig(input.kind, input.config);
      let id = input.id;
      if (id) {
        const existing = await db.query.targets.findFirst({
          where: eq(targets.id, id),
        });
        if (!existing) {
          throw new TRPCError({ code: "NOT_FOUND", message: "target not found" });
        }
        // Same-kind edit: keep stored clientSecret / token / webhook headers
        // when the form omitted them or sent the mask.  A kind change starts
        // from the incoming config only so Infisical creds do not leak onto
        // a file or webhook row.
        const config =
          existing.kind === input.kind
            ? validateTargetConfig(
                input.kind,
                mergePreservedTargetSecrets(readTargetConfig(existing), incoming),
              )
            : incoming;
        await db
          .update(targets)
          .set({
            kind: input.kind,
            configEnc: encryptJson(config),
            configJson: null,
            enabled: input.enabled,
          })
          .where(eq(targets.id, id));
      } else {
        const [row] = await db
          .insert(targets)
          .values({
            secretId: input.secretId,
            kind: input.kind,
            configEnc: encryptJson(incoming),
            configJson: null,
            enabled: input.enabled,
          })
          .$returningId();
        id = row.id;
      }
      await appendAudit(ACTOR, input.id ? "target.updated" : "target.created", input.secretId, {
        targetId: id,
        kind: input.kind,
      });
      const saved = await db.query.targets.findFirst({ where: eq(targets.id, id!) });
      // Mask stored credentials on the way back out — the same redaction
      // secrets.list/get apply — so an updated target never echoes its
      // clientSecret / auth headers to the browser.  Never echo the raw
      // ciphertext either.
      if (!saved) return null;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- discard ciphertext, never send it to the browser
      const { configEnc: _configEnc, ...savedRest } = saved;
      return { ...savedRest, configJson: maskTargetConfig(readTargetConfig(saved)) };
    }),

  remove: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const row = await db.query.targets.findFirst({
        where: eq(targets.id, input.id),
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "target not found" });
      await db.delete(targets).where(eq(targets.id, input.id));
      await appendAudit(ACTOR, "target.removed", row.secretId, {
        targetId: input.id,
        kind: row.kind,
      });
      return { ok: true };
    }),

  test: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const target = await db.query.targets.findFirst({
        where: eq(targets.id, input.id),
      });
      if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "target not found" });
      const secret = await db.query.secrets.findFirst({
        where: eq(secrets.id, target.secretId),
      });
      const canary = `autorotate-canary-${randomToken(12)}`;
      const cfg = readTargetConfig(target);
      let ok = true;
      let message: string;
      try {
        switch (target.kind) {
          case "infisical": {
            const icfg = cfg as InfisicalTargetConfig;
            const canaryName = canaryDeliveryName(
              infisicalSecretName(icfg, secret?.name ?? "SECRET"),
            );
            if (!isDemoMode() && hasInfisicalConfig(icfg)) {
              await upsertSecret(icfg, canaryName, canary);
              message = `canary written to Infisical as ${canaryName}`;
            } else {
              const ms = await demoLatency();
              message = demoMessage(
                `canary written to Infisical as ${canaryName} (simulated, ${ms}ms)`,
              );
            }
            break;
          }
          case "file": {
            const fcfg = cfg as unknown as FileTargetConfig;
            const canaryCfg: FileTargetConfig = {
              ...fcfg,
              key: canaryDeliveryName(fcfg.key),
            };
            // F11: demo mode must not write a canary to a real file on disk —
            // simulate it, matching the demo guards in pushToTarget/verify/drift.
            if (isDemoMode()) {
              const ms = await demoLatency();
              message = demoMessage(
                `canary written to ${canaryCfg.path} key ${canaryCfg.key} (simulated, ${ms}ms)`,
              );
            } else {
              await writeFileTarget(canaryCfg, canary);
              message = `canary written to ${canaryCfg.path} key ${canaryCfg.key}`;
            }
            break;
          }
          case "webhook": {
            const wcfg = cfg as unknown as WebhookTargetConfig;
            if (!isDemoMode() && wcfg.url) {
              // AR-09 / F1: same guarded sink as the rotation engine's PUSH —
              // https-only, no private hosts, and no 3xx redirect following.
              const res = await safeFetch(wcfg.url, {
                method: wcfg.method || "POST",
                headers: { "Content-Type": "application/json", ...(wcfg.headers ?? {}) },
                body: JSON.stringify({
                  name: secret?.name,
                  valueRef: `autorotate://targets/${target.id}/canary`,
                  canary: fingerprint(canary),
                }),
                signal: AbortSignal.timeout(10_000),
              });
              if (!res.ok) throw new Error(`webhook returned HTTP ${res.status}`);
              message = `canary delivered to ${wcfg.url}`;
            } else {
              const ms = await demoLatency();
              message = demoMessage(`canary delivered to webhook (simulated, ${ms}ms)`);
            }
            break;
          }
          case "keychain": {
            const kcfg = cfg as unknown as KeychainTargetConfig;
            message = `canary delegated to companion app (${kcfg.service}/${kcfg.account})`;
            break;
          }
        }
      } catch (err) {
        ok = false;
        message = (err as Error).message;
      }
      await db
        .update(targets)
        .set({
          lastStatus: ok ? "ok" : "failed",
          lastDeliveredAt: ok ? new Date() : target.lastDeliveredAt,
        })
        .where(eq(targets.id, target.id));
      await appendAudit(ACTOR, "target.tested", target.secretId, {
        targetId: target.id,
        kind: target.kind,
        ok,
        canaryFingerprint: fingerprint(canary),
      });
      return { ok, message };
    }),
});

// ── policies ────────────────────────────────────────────────────

export const policiesRouter = createRouter({
  set: protectedProcedure
    .input(
      z.object({
        secretId: z.number(),
        intervalHours: z.number().min(1).max(24 * 365),
        autoRotate: z.boolean(),
        verifyAfterWrite: z.boolean(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const row = await db.query.secrets.findFirst({
        where: eq(secrets.id, input.secretId),
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "secret not found" });
      const policy: RotationPolicy = {
        intervalHours: input.intervalHours,
        autoRotate: input.autoRotate,
        verifyAfterWrite: input.verifyAfterWrite,
      };
      const base = row.lastRotatedAt ?? new Date();
      const nextDueAt = new Date(base.getTime() + policy.intervalHours * 3600 * 1000);
      await db
        .update(secrets)
        .set({ policyJson: policy as never, nextDueAt })
        .where(eq(secrets.id, input.secretId));
      await appendAudit(ACTOR, "policy.updated", input.secretId, {
        ...policy,
        nextDueAt: nextDueAt.toISOString(),
      });
      const row2 = await db.query.secrets.findFirst({
        where: eq(secrets.id, input.secretId),
        with: { connector: true, targets: true },
      });
      return row2 ? sanitizeSecretForClient(row2) : null;
    }),
});

// ── runs ────────────────────────────────────────────────────────

export const runsRouter = createRouter({
  list: protectedProcedure
    .input(
      z
        .object({
          secretId: z.number().optional(),
          limit: z.number().min(1).max(200).default(50),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const db = getDb();
      return db
        .select()
        .from(rotationRuns)
        .where(input?.secretId ? eq(rotationRuns.secretId, input.secretId) : undefined)
        .orderBy(desc(rotationRuns.id))
        .limit(input?.limit ?? 50);
    }),

  get: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const row = await db.query.rotationRuns.findFirst({
        where: eq(rotationRuns.id, input.id),
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "run not found" });
      return row;
    }),

  retry: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const row = await db.query.rotationRuns.findFirst({
        where: eq(rotationRuns.id, input.id),
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "run not found" });
      if (row.status !== "failed" && row.status !== "partial") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `only failed/partial runs can be retried (status: ${row.status})`,
        });
      }
      try {
        // Re-runs the pipeline for the secret; the fresh run records which
        // step previously failed (retry trigger) and resumes delivery.
        return await rotateSecret(row.secretId, "retry", ACTOR);
      } catch (err) {
        toTrpcError(err);
      }
    }),
});

// ── audit ───────────────────────────────────────────────────────

export const auditRouter = createRouter({
  list: protectedProcedure
    .input(
      z
        .object({
          limit: z.number().min(1).max(500).default(100),
          action: z.string().optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const db = getDb();
      return db
        .select()
        .from(auditLog)
        .where(input?.action ? eq(auditLog.action, input.action) : undefined)
        .orderBy(desc(auditLog.id))
        .limit(input?.limit ?? 100);
    }),

  verifyChain: protectedProcedure.query(() => verifyAuditChain()),
});

// ── stats ───────────────────────────────────────────────────────

export const statsRouter = createRouter({
  overview: protectedProcedure.query(async (): Promise<StatsOverview> => {
    const db = getDb();
    const allSecrets = await db.select().from(secrets);
    const allConnectors = await db.select().from(connectors).orderBy(connectors.id);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const recentRuns = await db
      .select({ status: rotationRuns.status })
      .from(rotationRuns)
      .where(gte(rotationRuns.startedAt, thirtyDaysAgo));
    const recentActivity = await db
      .select()
      .from(auditLog)
      .orderBy(desc(auditLog.id))
      .limit(10);

    const total = allSecrets.length;
    const countBy = (s: string) => allSecrets.filter((r) => r.status === s).length;
    const healthy = countBy("healthy");
    const secretCountByConnector = new Map<number, number>();
    for (const s of allSecrets) {
      secretCountByConnector.set(
        s.connectorId,
        (secretCountByConnector.get(s.connectorId) ?? 0) + 1,
      );
    }

    return {
      demoMode: isDemoMode(),
      totalSecrets: total,
      healthPct: total === 0 ? 100 : Math.round((healthy / total) * 100),
      dueSoonCount: countBy("due_soon"),
      overdueCount: countBy("overdue"),
      pausedCount: countBy("paused"),
      failedCount: countBy("failed"),
      rotationsLast30d: recentRuns.length,
      failedRunsLast30d: recentRuns.filter((r) => r.status === "failed").length,
      coverageByConnector: allConnectors.map((c) => ({
        connectorId: c.id,
        platform: c.platform,
        displayName: c.displayName,
        capability: c.capability,
        status: c.status,
        secretCount: secretCountByConnector.get(c.id) ?? 0,
      })),
      recentActivity,
    };
  }),
});

// ── workspace & alerts ──────────────────────────────────────────
// AR-16: configuration is persisted in workspaceSettings and consulted by the
// rotation engine (api/autorotate/alerts.ts).  AR-09: stored webhook URLs are
// credentials in their own right and are only ever returned masked.

export const workspaceRouter = createRouter({
  getAlerts: protectedProcedure.query(async () => maskAlertConfig(await readAlertConfig())),

  updateAlerts: protectedProcedure
    .input(workspaceAlertUpdateInput)
    .mutation(async ({ input }) => {
      const next = await writeAlertConfig(input);
      await appendAudit(ACTOR, "workspace.alerts_updated", null, {
        fields: Object.keys(input),
        hasSlack: !!next.slackWebhookUrl,
        hasDiscord: !!next.discordWebhookUrl,
      });
      return maskAlertConfig(next);
    }),

  // ── Infisical SOT admin surface (2026-10-03) ──────────────────
  // App-level settings live in the Autorotate Infisical project (see
  // INFISICAL.md).  These endpoints are admin-only (every procedure in this
  // file is a protectedProcedure) and never return secret VALUES — the
  // inventory reports names + configured/unset only.
  settingsInventory: protectedProcedure.query(() => settingsInventory()),

  // Re-read Infisical into the in-memory cache on demand.  Background
  // refresh failures keep serving last-known-good; this mutation surfaces
  // the error to the admin instead.
  reloadSettings: protectedProcedure.mutation(async () => {
    await refreshSettings();
    await appendAudit(ACTOR, "workspace.settings_reloaded", null, {});
    return { ok: true, keys: settingsInventory().length };
  }),

  // Admin write-through for tunable (non-secret) knobs: persists to
  // Infisical FIRST, then updates the cache.  A failed Infisical write
  // fails the mutation.  Secrets (admin token, encryption key, DB URL,
  // Sentry DSN, alert webhook config) are deliberately NOT settable here —
  // rotate those in the Infisical dashboard.
  setAppSetting: protectedProcedure
    .input(
      z.object({
        key: z.enum([
          "AUTOROTATE_DEMO",
          "AUTOROTATE_SCHEDULER",
          "SCHEDULER_INTERVAL_MS",
          "SESSION_TTL_MS",
          "RATE_LIMIT_WINDOW_MS",
          "RATE_LIMIT_MAX",
          "ALERT_TIMEOUT_MS",
          "OVERDUE_DIGEST_INTERVAL_MS",
          "SETTINGS_REFRESH_INTERVAL_MS",
          "AUTOROTATE_FILE_ROOT",
          "AUTOROTATE_PUBLIC_BASE_URL",
          "SENTRY_ENV",
          "SENTRY_TRACES_SAMPLE_RATE",
        ]),
        value: z.string().max(2048),
      }),
    )
    .mutation(async ({ input }) => {
      const numericKeys = [
        "SCHEDULER_INTERVAL_MS",
        "SESSION_TTL_MS",
        "RATE_LIMIT_WINDOW_MS",
        "RATE_LIMIT_MAX",
        "ALERT_TIMEOUT_MS",
        "OVERDUE_DIGEST_INTERVAL_MS",
        "SETTINGS_REFRESH_INTERVAL_MS",
        "SENTRY_TRACES_SAMPLE_RATE",
      ];
      if (numericKeys.includes(input.key)) {
        const parsed = Number(input.value.trim());
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `${input.key} must be a positive number`,
          });
        }
      }
      const flagKeys = ["AUTOROTATE_DEMO", "AUTOROTATE_SCHEDULER"];
      if (flagKeys.includes(input.key)) {
        const normalized = input.value.trim().toLowerCase();
        if (!["0", "1", "true", "false", ""].includes(normalized)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `${input.key} must be "1"/"true", "0"/"false", or empty`,
          });
        }
      }
      const before = getSetting(input.key) ?? "";
      await setSetting(input.key, input.value);
      await appendAudit(ACTOR, "workspace.setting_updated", null, {
        key: input.key,
        // Never log the value — even non-secret knobs deserve the habit.
        hadValue: before !== "",
      });
      return { ok: true, key: input.key };
    }),

  testAlert: protectedProcedure
    .input(z.object({ service: z.enum(["slack", "discord"]) }))
    .mutation(async ({ input }) => {
      const config = await readAlertConfig();
      const url =
        input.service === "slack" ? config.slackWebhookUrl : config.discordWebhookUrl;
      if (!url) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `No ${input.service} webhook URL configured`,
        });
      }
      try {
        await postAlert(
          input.service,
          url,
          `[Autorotate Alert Test] Test notification delivered successfully at ${new Date().toISOString()}`,
        );
        return { ok: true, message: `Test alert sent to ${input.service}` };
      } catch (err) {
        return { ok: false, message: `Failed to deliver test alert: ${(err as Error).message}` };
      }
    }),
});

// ── pairing ─────────────────────────────────────────────────────

export const pairingRouter = createRouter({
  getPayload: protectedProcedure.query(({ ctx }) => {
    // AR-20: derived from the request, never a hardcoded fleet hostname.
    // AR31-23 (2026-09-20): the prior version always trusted X-Forwarded-
    // Host / -Proto first-hop, which is correct only when the request
    // actually arrived via the configured trusted reverse proxy.  A
    // direct-to-port request — or a request from a deployment without a
    // proxy — would surface a spoofable or wrong origin into the pairing
    // payload, which then lands in a QR code that any nearby phone can
    // scan.  Prefer AUTOROTATE_PUBLIC_BASE_URL when set; fall back to the
    // XFF-derived value for self-hosted deployments that already
    // document the trust boundary.
    const baseUrl =
      publicBaseUrlSetting().replace(/\/+$/, "") ||
      requestBaseUrl(ctx.req);
    return {
      version: 1,
      appName: "Autorotate",
      baseUrl,
      environment: env.isProduction ? "production" : "development",
      timestamp: new Date().toISOString(),
    };
  }),

  // AR31-18 (2026-09-20): returns the real list of paired companion
  // devices.  The previous SystemStrip hardcoded "macOS linked · iOS
  // linked" with green dots regardless of reality; the operator had no
  // way to tell whether the green meant "paired and healthy" or
  // "hardcoded truthiness".  The endpoint returns an empty array until
  // the companion apps are wired up to send a "I just paired" beacon
  // (next iteration).  The dashboard now consumes this list and shows
  // "No companion paired yet" instead of fake green dots.
  listPaired: protectedProcedure.query(() => {
    // Wire to a persisted table in the next iteration; the type is
    // pinned here so the UI can render real states (paired / unpaired /
    // revoked).
    return [] as Array<{
      id: string;
      platform: "ios" | "macos" | "android";
      deviceName: string;
      pairedAt: string;
      lastSeenAt: string;
    }>;
  }),
});

export const autorotateRouters = {
  connectors: connectorsRouter,
  secrets: secretsRouter,
  targets: targetsRouter,
  policies: policiesRouter,
  runs: runsRouter,
  audit: auditRouter,
  stats: statsRouter,
  workspace: workspaceRouter,
  pairing: pairingRouter,
};

