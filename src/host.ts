#!/usr/bin/env node
import { LoadTestEngine } from "./engine.js";
import type { EngineRequest, EngineResponse, LoadTestStatus, LoadMetrics, LoadTestResult } from "./protocol.js";

/**
 * Native-messaging host entry point. Chrome frames every message on
 * stdin/stdout as a 4-byte little-endian length prefix followed by that
 * many bytes of UTF-8 JSON — this is Chrome's own wire format, not
 * something we chose; see
 * https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
 *
 * Access control is the host manifest's `allowed_origins` (only the
 * extension ID(s) listed there may connect at all) plus the fact that this
 * only exists on stdio, never a network socket — nothing to authenticate
 * over the wire itself.
 */

function writeMessage(message: EngineResponse): void {
  const json = Buffer.from(JSON.stringify(message), "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(header);
  process.stdout.write(json);
}

let readBuffer = Buffer.alloc(0);

function onStdinData(chunk: Buffer): void {
  readBuffer = Buffer.concat([readBuffer, chunk]);
  while (true) {
    if (readBuffer.length < 4) return;
    const length = readBuffer.readUInt32LE(0);
    if (readBuffer.length < 4 + length) return;
    const body = readBuffer.subarray(4, 4 + length);
    readBuffer = readBuffer.subarray(4 + length);
    let message: EngineRequest;
    try {
      message = JSON.parse(body.toString("utf-8")) as EngineRequest;
    } catch {
      writeMessage({ type: "error", message: "Received a malformed message (invalid JSON)." });
      continue;
    }
    handleMessage(message);
  }
}

let engine: LoadTestEngine | undefined;
let currentStatus: LoadTestStatus = { state: "idle" };
let unsubscribeMetrics: (() => void) | undefined;

function handleMessage(message: EngineRequest): void {
  switch (message.type) {
    case "start": {
      if (engine) {
        writeMessage({ type: "error", message: "A load test is already running — stop it before starting a new one." });
        return;
      }
      engine = new LoadTestEngine(message.config);
      currentStatus = { state: "running", metrics: buildIdleMetrics(message.config.targetRps) };
      writeMessage({ type: "status", status: currentStatus });

      unsubscribeMetrics = engine.onMetrics((metrics: LoadMetrics) => {
        currentStatus = { state: "running", metrics };
        writeMessage({ type: "metrics", metrics });
      });

      engine
        .start()
        .then((result: LoadTestResult) => {
          currentStatus = { state: "done", result };
          writeMessage({ type: "completed", result });
          cleanupEngine();
        })
        .catch((err: unknown) => {
          const errMessage = err instanceof Error ? err.message : String(err);
          currentStatus = { state: "error", message: errMessage };
          writeMessage({ type: "error", message: errMessage });
          cleanupEngine();
        });
      return;
    }
    case "stop": {
      engine?.stop();
      writeMessage({ type: "status", status: currentStatus });
      return;
    }
    case "get-status": {
      writeMessage({ type: "status", status: currentStatus });
      return;
    }
  }
}

function cleanupEngine(): void {
  unsubscribeMetrics?.();
  unsubscribeMetrics = undefined;
  engine = undefined;
}

function buildIdleMetrics(targetRps: number): LoadMetrics {
  return {
    elapsedSeconds: 0,
    targetRps,
    actualRps: 0,
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    errorRate: 0,
    avgLatency: 0,
    p50: 0,
    p90: 0,
    p95: 0,
    p99: 0,
    maxLatency: 0,
    bytesReceived: 0,
    bytesSent: 0,
    activeConcurrency: 0,
    peakConcurrency: 0,
  };
}

process.stdin.on("data", onStdinData);
// Chrome closes stdin when the extension disconnects (tab/browser closed,
// or the port explicitly disconnected) — exiting here is what prevents an
// orphaned process from lingering after that.
process.stdin.on("end", () => {
  engine?.stop();
  process.exit(0);
});
