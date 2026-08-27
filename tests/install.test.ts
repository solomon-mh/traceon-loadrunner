import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const installJs = join(repoRoot, "dist/install.js");

// The installer only implements the linux paths beyond best-effort; these
// tests drive the linux branch (CI + the maintainer's platform).
const linuxOnly = process.platform === "linux" ? describe : describe.skip;

linuxOnly("install.js (linux)", () => {
  let home: string;
  let xdgData: string;
  let env: NodeJS.ProcessEnv;

  const dataDir = () => join(xdgData, "traceon-loadrunner");
  const hostMjs = () => join(dataDir(), "host.mjs");
  const manifestFile = () => join(home, ".config/google-chrome/NativeMessagingHosts/com.traceon.loadrunner.json");

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), "trlr-"));
    home = join(base, "home");
    xdgData = join(base, "data");
    // A pre-existing google-chrome profile dir so writeManifests targets it.
    env = { ...process.env, HOME: home, XDG_DATA_HOME: xdgData };
    execFileSync("mkdir", ["-p", join(home, ".config/google-chrome")]);
  });

  afterEach(() => {
    rmSync(dirname(home), { recursive: true, force: true });
  });

  const run = (...args: string[]) => execFileSync(process.execPath, [installJs, ...args], { env, stdio: "pipe" });

  it("copies a self-contained host to the stable data dir with an absolute-node shebang", () => {
    run("--extension-id", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    expect(existsSync(hostMjs())).toBe(true);
    expect(statSync(hostMjs()).mode & 0o777).toBe(0o755);

    const firstLine = readFileSync(hostMjs(), "utf-8").split("\n", 1)[0];
    expect(firstLine).toBe(`#!${process.execPath}`);
    expect(firstLine.startsWith("#!/")).toBe(true); // absolute, not `#!/usr/bin/env node`
  });

  it("writes a manifest pointing at the stable copy (never the package dir) with every extension id", () => {
    run("--extension-id", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "--extension-id", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

    expect(existsSync(manifestFile())).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestFile(), "utf-8"));
    expect(manifest.name).toBe("com.traceon.loadrunner");
    expect(manifest.type).toBe("stdio");
    expect(manifest.path).toBe(hostMjs());
    expect(manifest.path.startsWith(repoRoot)).toBe(false);
    expect(manifest.allowed_origins).toEqual([
      "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
      "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/",
    ]);
  });

  it("--uninstall removes the data dir and the manifest", () => {
    run("--extension-id", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(existsSync(dataDir())).toBe(true);
    expect(existsSync(manifestFile())).toBe(true);

    run("--uninstall");
    expect(existsSync(dataDir())).toBe(false);
    expect(existsSync(manifestFile())).toBe(false);
  });

  it("exits non-zero with usage when no extension id and no --uninstall", () => {
    expect(() => run()).toThrow();
  });
});
