import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { EngineRequest, EngineResponse } from "../src/protocol.js";

const hostJs = join(dirname(fileURLToPath(import.meta.url)), "../dist/host.js");

function frame(message: EngineRequest): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Reads exactly one length-prefixed frame off the stream. */
function readFrame(stdout: NodeJS.ReadableStream, timeoutMs = 3000): Promise<EngineResponse> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => reject(new Error("timed out waiting for a framed response")), timeoutMs);
    stdout.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4) return;
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) return;
      clearTimeout(timer);
      resolve(JSON.parse(buf.subarray(4, 4 + len).toString("utf-8")) as EngineResponse);
    });
    stdout.on("error", reject);
  });
}

describe("host.js (native-messaging framing)", () => {
  it("answers a framed get-status with a framed idle status, then exits when stdin closes", async () => {
    const child = spawn(process.execPath, [hostJs], { stdio: ["pipe", "pipe", "inherit"] });
    try {
      child.stdin.write(frame({ type: "get-status" }));
      const response = await readFrame(child.stdout);
      expect(response).toEqual({ type: "status", status: { state: "idle" } });
    } finally {
      child.stdin.end();
    }

    const exitCode: number = await new Promise((r) => child.on("exit", (code) => r(code ?? -1)));
    expect(exitCode).toBe(0);
  }, 10000);
});
