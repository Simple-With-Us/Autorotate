import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { FileTargetConfig } from "@contracts/autorotate";

import { fileRootSetting } from "./appSettings";

// Format-aware secret file writer. All paths are sandboxed under
// AUTOROTATE_FILE_ROOT (default: $HOME/app-engine/autorotate-files/ — falls back to
// <cwd>/autorotate-files when that env-independent default isn't available).
// The root comes from the Infisical settings cache (memory-only) — see
// appSettings.  Writes are atomic: tmp file in the same directory + rename.

export class FileTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileTargetError";
  }
}

export function fileRoot(): string {
  const configured = fileRootSetting();
  if (configured) return configured;
  const home = os.homedir();
  return path.join(home || process.cwd(), "app-engine", "autorotate-files");
}

/**
 * Resolve a user path inside the sandbox; throws on escape attempts.
 *
 * AR31-31 (2026-09-20): the previous synchronous `path.resolve` only
 * checked the LEXICAL path — a symlink inside the sandbox that pointed
 * outside (e.g. `sandbox/escape -> /etc`) would still pass the lexical
 * check, then the subsequent `fs.readFile` / `fs.writeFile` would follow
 * the link and let the rotation read or overwrite an arbitrary file on
 * the host.  Now resolves to the REAL path (following symlinks) and
 * re-checks containment.  For a write target that does not exist yet,
 * realpath is taken on the closest existing ancestor (the sandbox root
 * is required to exist, so this is always reachable).
 */
export async function resolveSandboxPath(relPath: string): Promise<string> {
  if (!relPath || relPath.length === 0) {
    throw new FileTargetError("resolveSandboxPath: empty path");
  }
  const lexicalRoot = path.resolve(fileRoot());
  const abs = path.resolve(lexicalRoot, relPath);
  // 1. Cheap lexical check first — catches `../` traversal and absolute
  //    paths before we touch the filesystem.
  if (abs !== lexicalRoot && !abs.startsWith(lexicalRoot + path.sep)) {
    throw new FileTargetError(
      `Path "${relPath}" escapes the file sandbox (${lexicalRoot})`,
    );
  }
  // 2. Symlink-aware check.  We compare realpath vs realpath of the
  //    SANDBOX ROOT (not its lexical location) because macOS resolves
  //    /var/folders → /private/var/folders, and Linux can do the same
  //    with /tmp → /private/tmp.  Comparing a realpath against the
  //    lexical root would always fail on those hosts.
  let realRoot: string;
  try {
    realRoot = await fs.realpath(lexicalRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new FileTargetError(
        `File sandbox root ${lexicalRoot} does not exist`,
      );
    }
    throw err;
  }
  let real: string;
  try {
    real = await fs.realpath(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // Target does not exist yet (write path).  Walk up until we find an
    // existing ancestor and realpath it.
    real = await realpathClosestExistingAncestor(abs);
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new FileTargetError(
      `Path "${relPath}" resolves to "${real}" which is outside the file sandbox (${lexicalRoot})`,
    );
  }
  // Return the LEXICAL abs so subsequent write/read addresses the path
  // the operator actually configured; the symlink check was for safety,
  // not normalization.
  return abs;
}

/** Realpath the closest existing ancestor of `abs`. */
async function realpathClosestExistingAncestor(abs: string): Promise<string> {
  let cur = abs;
  // Walk up at most a few dozen levels — pathological inputs (e.g. the
  // sandbox root itself missing) surface as ENOENT and re-throw with
  // the sandbox-root-missing message above.
  while (cur !== path.dirname(cur)) {
    try {
      const realCur = await fs.realpath(cur);
      // Reconstruct the tail (basename) on top of the realpathed ancestor.
      const tail = abs.slice(cur.length);
      return realCur + tail;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      cur = path.dirname(cur);
    }
  }
  // If we walked up to the filesystem root, give up — the caller will
  // surface ENOENT.
  throw Object.assign(new Error(`realpath: no existing ancestor of ${abs}`), {
    code: "ENOENT",
  });
}

async function readIfExists(abs: string): Promise<string> {
  try {
    return await fs.readFile(abs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

// ── Format updaters: return updated content ─────────────────────

function updateEnv(content: string, key: string, value: string): string {
  const lines = content.length ? content.split("\n") : [];
  const re = new RegExp(`^\\s*(?:export\\s+)?${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`);
  let replaced = false;
  const out = lines.map((line) => {
    if (!replaced && re.test(line)) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!replaced) {
    if (out.length && out[out.length - 1] === "") out.pop();
    out.push(`${key}=${value}`);
  }
  return out.join("\n").replace(/\n*$/, "\n");
}

function setByPath(obj: Record<string, unknown>, keyPath: string, value: string) {
  const parts = keyPath.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      cur[parts[i]] = {};
    }
    cur = cur[parts[i]] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

function updateJson(content: string, keyPath: string, value: string): string {
  let obj: Record<string, unknown> = {};
  if (content.trim()) {
    try {
      obj = JSON.parse(content) as Record<string, unknown>;
    } catch {
      throw new FileTargetError("JSON target contains invalid JSON");
    }
  }
  setByPath(obj, keyPath, value);
  return JSON.stringify(obj, null, 2) + "\n";
}

function updateFlatDelimited(
  content: string,
  key: string,
  value: string,
  separator: string,
): string {
  const render = separator === ":" ? `${key}: ${value}` : `${key} = ${value}`;
  const lines = content.length ? content.split("\n") : [];
  const re = new RegExp(
    `^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*${separator}`,
  );
  let replaced = false;
  const out = lines.map((line) => {
    if (!replaced && re.test(line)) {
      replaced = true;
      return render;
    }
    return line;
  });
  if (!replaced) {
    if (out.length && out[out.length - 1] === "") out.pop();
    out.push(render);
  }
  return out.join("\n").replace(/\n*$/, "\n");
}

/** INI with [section] support: key may be "section.key" or flat "key". */
function updateIni(content: string, keySpec: string, value: string): string {
  const hasSection = keySpec.includes(".");
  if (!hasSection) return updateFlatDelimited(content, keySpec, value, "=");
  const [section, key] = keySpec.split(".", 2);
  const lines = content.length ? content.split("\n") : [`[${section}]`];
  const sectionRe = new RegExp(
    `^\\s*\\[\\s*${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\]\\s*$`,
  );
  const keyRe = new RegExp(
    `^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`,
  );
  let inSection = false;
  let sectionFound = false;
  let replaced = false;
  let insertAt = -1;
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*\[.*\]\s*$/.test(line)) {
      if (inSection && !replaced && insertAt === -1) insertAt = out.length;
      inSection = sectionRe.test(line);
      if (inSection) sectionFound = true;
      out.push(line);
      continue;
    }
    if (inSection && !replaced && keyRe.test(line)) {
      out.push(`${key} = ${value}`);
      replaced = true;
      continue;
    }
    out.push(line);
  }
  if (!sectionFound) {
    if (out.length && out[out.length - 1] !== "") out.push("");
    out.push(`[${section}]`, `${key} = ${value}`);
  } else if (!replaced) {
    if (insertAt !== -1) out.splice(insertAt, 0, `${key} = ${value}`);
    else out.push(`${key} = ${value}`);
  }
  return out.join("\n").replace(/\n*$/, "\n");
}

export function renderUpdated(
  cfg: FileTargetConfig,
  content: string,
  value: string,
): string {
  switch (cfg.format) {
    case "env":
      return updateEnv(content, cfg.key, value);
    case "json":
      return updateJson(content, cfg.key, value);
    case "yaml":
      return updateFlatDelimited(content, cfg.key, value, ":");
    case "toml":
      return updateFlatDelimited(content, cfg.key, value, "=");
    case "ini":
      return updateIni(content, cfg.key, value);
    default:
      throw new FileTargetError(`Unsupported file format: ${cfg.format}`);
  }
}

/** Write value into a file target atomically. Returns the sandbox-relative path. */
export async function writeFileTarget(
  cfg: FileTargetConfig,
  value: string,
): Promise<string> {
  const abs = await resolveSandboxPath(cfg.path);
  const content = await readIfExists(abs);
  const updated = renderUpdated(cfg, content, value);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.autorotate-${process.pid}-${Date.now()}.tmp`;
  await fs.writeFile(tmp, updated, "utf8");
  await fs.rename(tmp, abs);
  return cfg.path;
}

/** Read back a file target and extract the current value at cfg.key. */
export async function readFileTarget(
  cfg: FileTargetConfig,
): Promise<string | null> {
  const abs = await resolveSandboxPath(cfg.path);
  let content: string;
  try {
    content = await fs.readFile(abs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (cfg.format === "json") {
    try {
      const obj = JSON.parse(content) as Record<string, unknown>;
      let cur: unknown = obj;
      for (const part of cfg.key.split(".")) {
        if (typeof cur !== "object" || cur === null) return null;
        cur = (cur as Record<string, unknown>)[part];
      }
      return typeof cur === "string" ? cur : null;
    } catch {
      throw new FileTargetError("JSON target contains invalid JSON");
    }
  }
  const separators: Record<string, string> = { env: "=", yaml: ":", toml: "=", ini: "=" };
  const sep = separators[cfg.format] ?? "=";
  const key = cfg.format === "ini" && cfg.key.includes(".")
    ? cfg.key.split(".", 2)[1]
    : cfg.key;
  const re = new RegExp(
    `^\\s*(?:export\\s+)?${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*${sep}\\s*(.*)$`,
    "m",
  );
  const match = content.match(re);
  return match ? match[1].trim() : null;
}
