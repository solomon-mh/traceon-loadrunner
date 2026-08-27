#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

/**
 * Registers this package as a Chrome Native Messaging host so
 * `chrome.runtime.connectNative("com.traceon.loadrunner")` from the traceOn
 * extension makes Chrome spawn the load-test host process.
 *
 *   npx traceon-loadrunner --extension-id <id> [--extension-id <id> …]
 *   npx traceon-loadrunner --uninstall
 *
 * The host bundle (dist/host.js) is copied to a STABLE per-user location and
 * the manifest points there — never at this package's own directory, which
 * under `npx` lives in npm's cache and gets garbage-collected. The copy's
 * shebang is rewritten to an absolute Node path so Chrome doesn't need
 * `node` on its (minimal) spawn PATH.
 *
 * Implemented and verified on Linux. macOS/Windows paths follow Chrome's
 * documented locations but haven't been exercised.
 */

const HOST_NAME = "com.traceon.loadrunner";
const APP_DIR_NAME = "traceon-loadrunner";
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Args {
  extensionIds: string[];
  uninstall: boolean;
}

function parseArgs(argv: string[]): Args {
  const extensionIds: string[] = [];
  let uninstall = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--extension-id") {
      const id = argv[++i];
      if (id) extensionIds.push(id);
    } else if (argv[i] === "--uninstall") {
      uninstall = true;
    }
  }
  if (!uninstall && extensionIds.length === 0) {
    console.error(
      "Usage:\n" +
        "  npx traceon-loadrunner --extension-id <id> [--extension-id <id> …]\n" +
        "  npx traceon-loadrunner --uninstall\n\n" +
        "Copy the full command (with your extension's ID already filled in) from\n" +
        "the traceOn extension's Load Test panel.",
    );
    process.exit(1);
  }
  return { extensionIds, uninstall };
}

/** Chrome/Chromium NativeMessagingHosts directories to (un)register in. */
function nativeMessagingHostsDirs(): string[] {
  const home = homedir();
  switch (process.platform) {
    case "linux":
      return [
        join(home, ".config/google-chrome/NativeMessagingHosts"),
        join(home, ".config/chromium/NativeMessagingHosts"),
      ];
    case "darwin":
      return [join(home, "Library/Application Support/Google/Chrome/NativeMessagingHosts")];
    case "win32":
      return [
        join(process.env.LOCALAPPDATA ?? join(home, "AppData/Local"), "Google/Chrome/NativeMessagingHosts"),
      ];
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

/** Stable per-user data directory the host bundle is copied into. */
function dataDir(): string {
  const home = homedir();
  switch (process.platform) {
    case "linux":
      return join(process.env.XDG_DATA_HOME ?? join(home, ".local/share"), APP_DIR_NAME);
    case "darwin":
      return join(home, "Library/Application Support", APP_DIR_NAME);
    case "win32":
      return join(process.env.LOCALAPPDATA ?? join(home, "AppData/Local"), APP_DIR_NAME);
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

function setWindowsRegistryKey(manifestPath: string): void {
  const keyPath = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
  execFileSync("reg", ["add", keyPath, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"], { stdio: "inherit" });
}

function deleteWindowsRegistryKey(): void {
  const keyPath = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
  try {
    execFileSync("reg", ["delete", keyPath, "/f"], { stdio: "inherit" });
  } catch {
    // Key may not exist — not fatal.
  }
}

/** Copy dist/host.js to <dataDir>, rewriting the shebang to this Node's
 * absolute path. Returns the path Chrome's manifest should point at. */
function installStableHost(dir: string): string {
  const bundlePath = join(packageRoot, "dist/host.js");
  if (!existsSync(bundlePath)) {
    console.error(`${bundlePath} is missing — the package build did not run.`);
    process.exit(1);
  }
  mkdirSync(dir, { recursive: true });

  let body = readFileSync(bundlePath, "utf-8");
  if (body.startsWith("#!")) body = body.slice(body.indexOf("\n") + 1);
  const hostMjs = join(dir, "host.mjs");
  writeFileSync(hostMjs, `#!${process.execPath}\n${body}`);
  chmodSync(hostMjs, 0o755);

  if (process.platform === "win32") {
    // Windows has no shebang support — Chrome execs the manifest path
    // directly, so it needs a .cmd wrapper.
    const hostCmd = join(dir, "host.cmd");
    writeFileSync(hostCmd, `@echo off\r\n"${process.execPath}" "${hostMjs}" %*\r\n`);
    return hostCmd;
  }
  return hostMjs;
}

function writeManifests(hostPath: string, extensionIds: string[]): string[] {
  const manifest = {
    name: HOST_NAME,
    description: "traceOn Load Test Engine — local HTTP load generator",
    path: hostPath,
    type: "stdio",
    allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`),
  };
  const written: string[] = [];
  const dirs = nativeMessagingHostsDirs();
  for (const dir of dirs) {
    // Only create the first candidate unconditionally; others only if that
    // browser's profile dir actually exists.
    if (dir !== dirs[0] && !existsSync(dirname(dir))) continue;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${HOST_NAME}.json`);
    writeFileSync(file, JSON.stringify(manifest, null, 2));
    written.push(file);
  }
  return written;
}

function doInstall(extensionIds: string[]): void {
  const dir = dataDir();
  const hostPath = installStableHost(dir);
  const manifests = writeManifests(hostPath, extensionIds);

  if (manifests.length === 0) {
    console.error("Could not find a Chrome/Chromium profile directory to register the host in.");
    process.exit(1);
  }
  if (process.platform === "win32") setWindowsRegistryKey(manifests[0]!);

  console.log(`Installed host → ${hostPath}`);
  for (const m of manifests) console.log(`Registered      → ${m}`);
  console.log(`Allowed extensions: ${extensionIds.join(", ")}`);
  console.log('\nReload the traceOn extension, open the Load Test panel, and click "Start TraceOn Load Test Engine".');
}

function doUninstall(): void {
  const dir = dataDir();
  rmSync(dir, { recursive: true, force: true });

  for (const nmDir of nativeMessagingHostsDirs()) {
    rmSync(join(nmDir, `${HOST_NAME}.json`), { force: true });
  }
  if (process.platform === "win32") deleteWindowsRegistryKey();

  console.log(`Removed ${dir} and the ${HOST_NAME} manifest(s).`);
}

const args = parseArgs(process.argv.slice(2));
if (args.uninstall) doUninstall();
else doInstall(args.extensionIds);
