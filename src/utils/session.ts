/**
 * Per-process correlation identifiers for nyx CLI.
 *
 * SESSION_ID and TRACE_ID are generated once at module load and remain
 * constant for the lifetime of this CLI invocation. One nyx command =
 * one logical user action, so all API calls (including the status-poll
 * loop) share the same trace_id.
 */

import { newSessionId, newTraceId, newRequestId } from "./observability.js";

export const SESSION_ID: string = newSessionId();
export const TRACE_ID: string = newTraceId();

export { newRequestId };
