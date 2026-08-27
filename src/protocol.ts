/**
 * The wire protocol between the traceOn Chrome extension and this host: the
 * Load Test config/metrics/result shapes and the native-messaging request/
 * response messages.
 *
 * This module is the single source of truth. It's published as the
 * `traceon-loadrunner/protocol` subpath export, and the extension imports
 * the types from it (`src/loadtest/loadRunner.ts`) rather than keeping its
 * own copy.
 */

export interface LoadTestConfig {
  targetUrl: string;
  targetRps: number;
  durationSeconds: number;
  rampUpSeconds: number;
  maxConcurrency: number;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
}

export interface LoadMetrics {
  elapsedSeconds: number;
  targetRps: number;
  actualRps: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  errorRate: number;
  avgLatency: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  maxLatency: number;
  bytesReceived: number;
  bytesSent: number;
  activeConcurrency: number;
  peakConcurrency: number;
  lastError?: string;
  lastErrorStatus?: number;
}

export interface LoadTestTimeseriesPoint {
  tSec: number;
  rps: number;
  p95: number;
  errorRate: number;
  throughputBps: number;
  activeConcurrency: number;
}

export interface LoadTestResult {
  config: LoadTestConfig;
  startedAt: number;
  durationMs: number;
  activeLoadDurationMs: number;
  gracefulShutdownMs: number;
  finalMetrics: LoadMetrics;
  timeseries: LoadTestTimeseriesPoint[];
}

export type LoadTestStatus =
  | { state: "idle" }
  | { state: "running"; metrics: LoadMetrics }
  | { state: "done"; result: LoadTestResult }
  | { state: "error"; message: string };

export type EngineRequest = { type: "start"; config: LoadTestConfig } | { type: "stop" } | { type: "get-status" };

export type EngineResponse =
  | { type: "status"; status: LoadTestStatus }
  | { type: "metrics"; metrics: LoadMetrics }
  | { type: "completed"; result: LoadTestResult }
  | { type: "error"; message: string };
