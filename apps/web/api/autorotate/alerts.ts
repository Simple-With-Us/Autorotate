import { desc } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { workspaceSettings } from "@db/schema";
import {
  workspaceAlertConfigSchema,
  type MaskedWorkspaceAlertConfig,
  type WorkspaceAlertConfig,
  type WorkspaceAlertUpdateInput,
} from "@contracts/autorotate";
import { safeFetch } from "./netguard";
import {
  alertConfigJsonSetting,
  alertTimeoutMsSetting,
  overdueDigestIntervalMsSetting,
  setSetting,
} from "./appSettings";

// ── Workspace alerts (AR-16) ────────────────────────────────────
// Infisical SOT (2026-10-03): the alert configuration is app-level config
// and now lives in the Infisical settings cache as ALERT_CONFIG_JSON
// (webhook URLs are secret-bearing, which is exactly what Infisical is
// for).  Reads are memory-only — the rotation engine previously hit MySQL
// on every completed run to fetch this; now it costs nothing.  Admin saves
// are write-through: Infisical FIRST, then the cache; a failed Infisical
// write fails the save so the two can never diverge silently.
//
// One-shot migration: the config used to live in a workspaceSettings row.
// On first read, when ALERT_CONFIG_JSON is unset but a DB row exists, the
// row is migrated through the write-through path (so Infisical becomes the
// source of truth immediately) and logged loudly.  The table is otherwise
// untouched — no schema migration needed.
//
// Payloads carry the secret NAME, run status, run id and a timestamp.  Never
// a value, never a fingerprint: an alert webhook is a third-party endpoint
// and fingerprints are the one trace of plaintext this product keeps.

export const DEFAULT_ALERT_CONFIG: WorkspaceAlertConfig = {
  slackWebhookUrl: "",
  discordWebhookUrl: "",
  notifyOnFailure: true,
  notifyOnPartial: true,
  notifyOnOverdue: true,
};

let migrationAttempted = false;

/** Test-only: allow the one-shot migration to run again. */
export function __resetAlertMigrationForTests(): void {
  migrationAttempted = false;
}

function parseAlertConfig(raw: string | undefined): WorkspaceAlertConfig {
  if (!raw) return { ...DEFAULT_ALERT_CONFIG };
  try {
    const parsed = workspaceAlertConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : { ...DEFAULT_ALERT_CONFIG };
  } catch {
    return { ...DEFAULT_ALERT_CONFIG };
  }
}

/**
 * Read the alert config from the Infisical settings cache (memory-only).
 * Performs the one-shot DB migration on first call when needed.
 */
export async function readAlertConfig(): Promise<WorkspaceAlertConfig> {
  const raw = alertConfigJsonSetting();
  if (raw) return parseAlertConfig(raw);
  if (!migrationAttempted) {
    migrationAttempted = true;
    const migrated = await migrateAlertConfigFromDb();
    if (migrated) return migrated;
  }
  return { ...DEFAULT_ALERT_CONFIG };
}

/**
 * Write-through save: Infisical FIRST (via the settings service), cache
 * updated by the settings service itself.  Rejects when the Infisical
 * write fails — the cache is left untouched.
 */
export async function writeAlertConfig(
  patch: WorkspaceAlertUpdateInput,
): Promise<WorkspaceAlertConfig> {
  const current = await readAlertConfig();
  const next: WorkspaceAlertConfig = { ...current, ...patch };
  await setSetting("ALERT_CONFIG_JSON", JSON.stringify(next));
  return next;
}

/**
 * One-shot migration of the legacy workspaceSettings row into Infisical.
 * Returns the migrated config, or null when there is nothing to migrate.
 * Runs at most once per process.
 */
async function migrateAlertConfigFromDb(): Promise<WorkspaceAlertConfig | null> {
  let row: { alertsJson: unknown } | undefined;
  try {
    const db = getDb();
    [row] = await db
      .select()
      .from(workspaceSettings)
      .orderBy(desc(workspaceSettings.id))
      .limit(1);
  } catch (err) {
    // The DB may be unreachable or the table absent (fresh deploy): that is
    // fine — there is simply nothing to migrate.
    console.warn(
      "[autorotate alerts] legacy alert-config migration skipped (DB read failed):",
      (err as Error).message,
    );
    return null;
  }
  const parsed = workspaceAlertConfigSchema.safeParse(row?.alertsJson ?? {});
  if (!row || !parsed.success) return null;
  try {
    await setSetting("ALERT_CONFIG_JSON", JSON.stringify(parsed.data));
    console.log(
      "[autorotate alerts] migrated workspace alert config from workspaceSettings to Infisical (ALERT_CONFIG_JSON).",
    );
    return parsed.data;
  } catch (err) {
    console.error(
      "[autorotate alerts] legacy alert-config migration failed:",
      (err as Error).message,
    );
    return { ...DEFAULT_ALERT_CONFIG };
  }
}

/** scheme + host + "/…" + the last 4 characters, or null when unset. */
export function maskWebhookUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const tail = raw.slice(-4);
  return `${url.protocol}//${url.host}/…${tail}`;
}

export function maskAlertConfig(config: WorkspaceAlertConfig): MaskedWorkspaceAlertConfig {
  return {
    hasSlack: !!config.slackWebhookUrl,
    hasDiscord: !!config.discordWebhookUrl,
    slackWebhookMasked: maskWebhookUrl(config.slackWebhookUrl),
    discordWebhookMasked: maskWebhookUrl(config.discordWebhookUrl),
    notifyOnFailure: config.notifyOnFailure,
    notifyOnPartial: config.notifyOnPartial,
    notifyOnOverdue: config.notifyOnOverdue,
  };
}

/** POST one alert message, SSRF-guarded and time-boxed. */
export async function postAlert(
  service: "slack" | "discord",
  url: string,
  text: string,
): Promise<void> {
  const payload = service === "slack" ? { text } : { content: text };
  // F1: safeFetch validates the URL and refuses to follow a 3xx redirect to an
  // internal host, so an alert webhook cannot be turned into an SSRF pivot.
  const res = await safeFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(alertTimeoutMsSetting()),
  });
  if (!res.ok) throw new Error(`${service} webhook returned HTTP ${res.status}`);
}

export type RunOutcomeAlert = {
  runId: number;
  secretName: string;
  status: "committed" | "partial" | "failed";
  at?: Date;
};

/** Message text for a completed run — name, status, run id, time.  Nothing else. */
export function runOutcomeMessage(alert: RunOutcomeAlert): string {
  const at = (alert.at ?? new Date()).toISOString();
  const headline =
    alert.status === "failed"
      ? "Rotation failed"
      : "Rotation partially delivered";
  return `[Autorotate] ${headline}: ${alert.secretName} — run #${alert.runId} at ${at}`;
}

function shouldNotify(config: WorkspaceAlertConfig, status: RunOutcomeAlert["status"]): boolean {
  if (status === "failed") return config.notifyOnFailure;
  if (status === "partial") return config.notifyOnPartial;
  return false;
}

/**
 * Fire-and-forget notification for a completed rotation run.  Never throws:
 * a dead alert webhook must not turn a successful rotation into a failed one.
 */
export async function notifyRunOutcome(alert: RunOutcomeAlert): Promise<void> {
  try {
    const config = await readAlertConfig();
    if (!shouldNotify(config, alert.status)) return;
    const text = runOutcomeMessage(alert);
    await deliver(config, text);
  } catch (err) {
    console.error("[autorotate alerts] run outcome notification failed:", (err as Error).message);
  }
}

async function deliver(config: WorkspaceAlertConfig, text: string): Promise<void> {
  const sends: Promise<void>[] = [];
  if (config.slackWebhookUrl) sends.push(postAlert("slack", config.slackWebhookUrl, text));
  if (config.discordWebhookUrl) sends.push(postAlert("discord", config.discordWebhookUrl, text));
  const results = await Promise.allSettled(sends);
  for (const result of results) {
    if (result.status === "rejected") {
      console.error(
        "[autorotate alerts] delivery failed:",
        (result.reason as Error)?.message ?? String(result.reason),
      );
    }
  }
}

// ── Overdue digest ──────────────────────────────────────────────
// One summary per process per window (window length from the settings cache:
// OVERDUE_DIGEST_INTERVAL_MS).  Module-level state, so a multi-replica
// deployment sends at most one digest per replica per window — acceptable for
// a nag, and the honest alternative (a shared store) is not worth a table.

let lastOverdueNotifyAt = 0;

export function shouldSendOverdueDigest(
  overdueCount: number,
  now: number = Date.now(),
): boolean {
  if (overdueCount <= 0) return false;
  return now - lastOverdueNotifyAt >= overdueDigestIntervalMsSetting();
}

export function resetOverdueDigestThrottle(): void {
  lastOverdueNotifyAt = 0;
}

export async function notifyOverdue(
  overdueCount: number,
  now: Date = new Date(),
): Promise<void> {
  try {
    if (!shouldSendOverdueDigest(overdueCount, now.getTime())) return;
    const config = await readAlertConfig();
    if (!config.notifyOnOverdue) return;
    if (!config.slackWebhookUrl && !config.discordWebhookUrl) return;
    lastOverdueNotifyAt = now.getTime();
    await deliver(
      config,
      `[Autorotate] ${overdueCount} secret(s) are past their rotation deadline as of ${now.toISOString()}`,
    );
  } catch (err) {
    console.error("[autorotate alerts] overdue digest failed:", (err as Error).message);
  }
}
