import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveSandboxPath,
  writeFileTarget,
  readFileTarget,
} from "./files";
import {
  initAppSettings,
  __setLocalSettingForTests,
  __resetSettingsForTests,
} from "./appSettings";

// AR31-31 (2026-09-20): sandbox must refuse symlinks that point outside
// the configured root, even when the lexical path stays inside the
// sandbox.
//
// Infisical SOT: the file root comes from the settings cache (memory-only).
// Tests run in local-dev mode and seed it via the test-only cache writer.

let root: string;
let outsideDir: string;
let outsideFile: string;

beforeAll(async () => {
  delete process.env.INFISICAL_CLIENT_ID;
  delete process.env.INFISICAL_CLIENT_SECRET;
  await initAppSettings();
});

afterAll(() => {
  __resetSettingsForTests();
});

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ar-sandbox-"));
  outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "ar-outside-"));
  outsideFile = path.join(outsideDir, "secret.txt");
  await fs.writeFile(outsideFile, "outside-content\n", "utf8");
  __setLocalSettingForTests("AUTOROTATE_FILE_ROOT", root);
});

afterEach(async () => {
  __setLocalSettingForTests("AUTOROTATE_FILE_ROOT", undefined);
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outsideDir, { recursive: true, force: true });
});

describe("AR31-31 — sandbox escape via symlink", () => {
  it("refuses a symlink inside the sandbox that points outside", async () => {
    const link = path.join(root, "escape");
    await fs.symlink(outsideFile, link);

    await expect(resolveSandboxPath("escape")).rejects.toThrow(
      /outside the file sandbox/i,
    );
  });

  it("refuses `../` lexical escape (existing behavior)", async () => {
    await expect(resolveSandboxPath("../escape")).rejects.toThrow(
      /escapes the file sandbox/i,
    );
  });

  it("refuses an absolute path outside the sandbox (existing behavior)", async () => {
    await expect(resolveSandboxPath(outsideFile)).rejects.toThrow(
      /escapes the file sandbox/i,
    );
  });

  it("allows a real file inside the sandbox", async () => {
    const real = path.join(root, "real.txt");
    await fs.writeFile(real, "ok", "utf8");

    await expect(resolveSandboxPath("real.txt")).resolves.toBe(real);
  });

  it("allows a non-existent path inside the sandbox for write", async () => {
    const target = await resolveSandboxPath("new/file.txt");
    expect(target).toBe(path.join(root, "new/file.txt"));
  });

  it("refuses a symlink to a directory outside the sandbox", async () => {
    const linkDir = path.join(root, "link-dir");
    await fs.symlink(outsideDir, linkDir, "dir");

    await expect(resolveSandboxPath("link-dir/whatever.txt")).rejects.toThrow(
      /outside the file sandbox/i,
    );
  });

  it("writeFileTarget refuses to write through a symlink that escapes", async () => {
    const link = path.join(root, "escape");
    await fs.symlink(outsideFile, link);

    await expect(
      writeFileTarget(
        { path: "escape", format: "env", key: "KEY" },
        "rewritten",
      ),
    ).rejects.toThrow(/outside the file sandbox/i);

    // The file outside the sandbox must be untouched.
    expect(await fs.readFile(outsideFile, "utf8")).toBe("outside-content\n");
  });

  it("readFileTarget refuses to read through a symlink that escapes", async () => {
    const link = path.join(root, "escape");
    await fs.symlink(outsideFile, link);

    await expect(
      readFileTarget({
        path: "escape",
        format: "env",
        key: "KEY",
      }),
    ).rejects.toThrow(/outside the file sandbox/i);
  });
});
