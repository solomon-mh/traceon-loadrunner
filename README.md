# traceon-loadrunner

The local HTTP load generator for the [traceOn](https://github.com/solomon-mh/traceon) Chrome extension's **Load Test** feature, run as a [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) host.

The extension can't generate high-rate HTTP load itself without freezing the browser, and it can't reach a local process except through a registered native-messaging host. This package is that host.

## Install

Requires **Node.js ≥ 18**.

```sh
npx traceon-loadrunner --extension-id <your-extension-id>
```

Get the full command — with your extension's ID already filled in — from the extension's **Load Test** panel (Performance Test tab). Then reload the extension and click **Start TraceOn Load Test Engine**.

If you run more than one traceOn install (e.g. an unpacked dev build alongside the Web Store one), pass `--extension-id` once per ID.

## What it writes to your machine

- A ~10 KB host script at:
  - Linux: `~/.local/share/traceon-loadrunner/host.mjs`
  - macOS: `~/Library/Application Support/traceon-loadrunner/host.mjs`
  - Windows: `%LOCALAPPDATA%\traceon-loadrunner\host.mjs` (+ `host.cmd`)
- One native-messaging manifest (`com.traceon.loadrunner.json`) in Chrome's / Chromium's `NativeMessagingHosts` directory, listing your extension ID(s) in `allowed_origins`. On Windows, an `HKCU` registry key pointing at it.

The script's shebang is set to the absolute path of the Node that ran the install, so Chrome doesn't need `node` on its PATH. If you later remove or relocate that Node (e.g. an `nvm` switch), re-run the install command.

## Uninstall

```sh
npx traceon-loadrunner --uninstall
```

Removes the data directory and the manifest(s) / registry key.

## Platform support

Implemented and verified on **Linux**. macOS and Windows follow Chrome's documented native-messaging locations but haven't been exercised end-to-end — file an issue if registration fails.

## For contributors

- `src/protocol.ts` is the **source of truth** for the wire types (`LoadTestConfig`, `LoadMetrics`, `LoadTestResult`, `EngineRequest`, `EngineResponse`, …). It's published as the `traceon-loadrunner/protocol` subpath, and the traceOn extension imports its types from there.
- `src/engine.ts` + `rateScheduler.ts` + `concurrencyPool.ts` + `histogram.ts` — the load engine (rate scheduling, concurrency cap, streaming latency histogram). Chrome-free, Node-free beyond `fetch`.
- `src/host.ts` — the native-messaging framing (4-byte length prefix + JSON).
- `src/install.ts` — this CLI.
- `npm run build` bundles `dist/host.js` (self-contained) + `dist/install.js` via esbuild and emits `dist/protocol.d.ts` via tsc.
- `npm test` — engine + install + host tests (no real Chrome involved).
