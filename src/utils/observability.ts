/**
 * Request-correlation headers for the Nyx CLI.
 *
 * The header names and ID formats this client sends so a request can be
 * followed end to end. They are the wire-level format the Fabraix API
 * expects.
 */

import { randomBytes } from "node:crypto";

export const HEADER_TRACE_ID = "X-Trace-Id";
export const HEADER_SESSION_ID = "X-Session-Id";
export const HEADER_REQUEST_ID = "X-Request-Id";
export const HEADER_SOURCE = "X-Source";

export type Source = "cli";

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
