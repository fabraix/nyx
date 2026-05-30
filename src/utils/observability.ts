/**
 * Observability contract for the Nyx CLI.
 *
 * HTTP headers and log-field names this client uses for cross-service
 * log correlation. The values here are the wire-level format expected
 * by Fabraix services — keep them in sync with the server-side contract
 * if you change them.
 */

import { randomBytes } from "node:crypto";

export const HEADER_TRACE_ID = "X-Trace-Id";
export const HEADER_SESSION_ID = "X-Session-Id";
export const HEADER_REQUEST_ID = "X-Request-Id";
export const HEADER_SOURCE = "X-Source";

export type Source = "app" | "cli" | "brain" | "engine";
export const SOURCES: readonly Source[] = ["app", "cli", "brain", "engine"];

export const FIELD_TS = "ts";
export const FIELD_SEVERITY = "severity";
export const FIELD_LEVEL = "level";
export const FIELD_LOGGER = "logger";
export const FIELD_EVENT = "event";
export const FIELD_TRACE_ID = "trace_id";
export const FIELD_SESSION_ID = "session_id";
export const FIELD_REQUEST_ID = "request_id";
export const FIELD_USER_ID = "user_id";
export const FIELD_RUN_ID = "run_id";
export const FIELD_SOURCE = "source";
export const FIELD_EXCEPTION = "exception";
export const FIELD_DURATION_MS = "duration_ms";
export const FIELD_STATUS_CODE = "status_code";
export const FIELD_PATH = "path";
export const FIELD_METHOD = "method";

export const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
export const SESSION_ID_PATTERN = /^[0-9a-f]{16}$/;
export const REQUEST_ID_PATTERN = /^[0-9a-f]{16}$/;

function randomHex(byteLength: number): string {
  return randomBytes(byteLength).toString("hex");
}

export function newTraceId(): string {
  return randomHex(16);
}

export function newSessionId(): string {
  return randomHex(8);
}

export function newRequestId(): string {
  return randomHex(8);
}

export function isValidTraceId(v: string | null | undefined): boolean {
  if (!v) return false;
  return TRACE_ID_PATTERN.test(v);
}

export function isValidSessionId(v: string | null | undefined): boolean {
  if (!v) return false;
  return SESSION_ID_PATTERN.test(v);
}

export function isValidRequestId(v: string | null | undefined): boolean {
  if (!v) return false;
  return REQUEST_ID_PATTERN.test(v);
}
