import { getExpectedAccountId, getToken } from "../config/auth.js";
import { getBaseUrl } from "./client.js";
import { NyxError } from "../utils/errors.js";
import { HEADER_REQUEST_ID, HEADER_SESSION_ID, HEADER_SOURCE, HEADER_TRACE_ID, newRequestId } from "../utils/observability.js";
import { SESSION_ID, TRACE_ID } from "../utils/session.js";
import {
  prepareCreateSession,
  prepareMessage,
  type OutboxReceiptQuery,
  type OutboxReceiptState,
} from "./request-outbox.js";

export interface Session {
  session_id: string;
  status: string;
  run_id?: string | null;
  active_turn_id?: string | null;
  budget_usd?: number;
  spent_usd?: number;
  account_id?: string;
  pending_questions?: SessionItem[];
  pending_questions_sequence?: number;
  [key: string]: unknown;
}

export interface SessionAgent {
  agent_path: string;
  status: string;
  active_turn_id?: string | null;
  state_sequence?: number;
  [key: string]: unknown;
}

export interface SessionItem {
  sequence: number;
  kind: string;
  agent_path?: string;
  ref?: string;
  correlation_id?: string;
  payload: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AcceptedMessage {
  session_id: string;
  message_id: string;
  sequence: number;
  completion_token: string;
  queued: boolean;
}

export interface PendingOperation {
  operation_id: string;
  kind: string;
  agent_id: string;
  turn_id: string;
  tool_name?: string | null;
  supported: boolean;
}

export interface OperationResolution {
  action: "model_receipt" | "tool_result" | "confirmed_not_dispatched";
  resolution_id: string;
  evidence_refs: string[];
  actual_cost_usd?: number;
  receipt?: Record<string, unknown>;
  response?: Record<string, unknown>;
  result?: unknown;
}

export interface RunResume {
  run_id: string;
  session_id: string;
  status: "active" | "pending" | "dispatched";
}

interface CreateRequestReceipt {
  state: "committed" | "not_committed";
  session_id?: string | null;
}

interface MessageRequestReceipt {
  state: OutboxReceiptState;
  completion_token?: string | null;
  sequence?: number | null;
}

export function retryableTransportError(error: unknown): boolean {
  return error instanceof NyxError && (error.category === "network"
    || (error.statusCode !== undefined && (error.statusCode === 408 || error.statusCode === 429
      || (error.statusCode >= 500 && error.statusCode < 600))));
}

export interface ItemPage {
  items: SessionItem[];
  next_sequence: number;
}

const prefix = "/v1/nyx/sessions";

function isSynchronousRejection(error: unknown): error is NyxError {
  return error instanceof NyxError && error.statusCode !== undefined
    && error.statusCode >= 400 && error.statusCode < 500
    && ![408, 429].includes(error.statusCode);
}

function retireRejectedRequest(error: unknown, pending: { rejectIfUnambiguous(attempt: number): boolean },
  attempt: number): void {
  if (isSynchronousRejection(error)) pending.rejectIfUnambiguous(attempt);
}

function validateSessionAcknowledgement(value: Session): Session {
  if (!value || typeof value !== "object" || typeof value.session_id !== "string"
    || !value.session_id.trim() || value.session_id.length > 200
    || typeof value.status !== "string" || !value.status.trim() || value.status.length > 64
    || /[\u0000-\u001f\u007f]/.test(value.session_id + value.status)) {
    throw new NyxError("Session API returned an invalid create acknowledgement; retrying is safe.", "network");
  }
  return value;
}

function validateMessageAcknowledgement(value: AcceptedMessage, sessionId: string,
  messageId: string): AcceptedMessage {
  if (!value || typeof value !== "object" || value.session_id !== sessionId
    || value.message_id !== messageId || value.queued !== true
    || !Number.isSafeInteger(value.sequence) || value.sequence < 1
    || typeof value.completion_token !== "string" || !value.completion_token
    || value.completion_token.length > 300 || /[\u0000-\u001f\u007f]/.test(value.completion_token)) {
    throw new NyxError("Session API returned an invalid message acknowledgement; retrying is safe.", "network");
  }
  return value;
}

/** Send account-bound session requests with bounded transport waits. */
async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const token = getToken();
  if (!token) throw new NyxError("Not authenticated. Run `nyx login` or set NYX_TOKEN.", "auth");
  const accountId = getExpectedAccountId();
  if (!accountId) {
    throw new NyxError(
      "Nyx needs an account-bound identity. Run `nyx login --check` or set NYX_ACCOUNT_ID with NYX_TOKEN.",
      "auth",
    );
  }
  const headers: Record<string, string> = {
    "X-Verification-Token": token,
    "X-Nyx-Account-ID": accountId,
    Accept: "application/json",
    [HEADER_REQUEST_ID]: newRequestId(),
    [HEADER_SESSION_ID]: SESSION_ID,
    [HEADER_TRACE_ID]: TRACE_ID,
    [HEADER_SOURCE]: "cli",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const abort = new AbortController();
  const cancel = () => abort.abort(signal?.reason);
  if (signal?.aborted) cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => abort.abort(), 30_000);
  try {
    let response: Response;
    try {
      response = await fetch(`${getBaseUrl().replace(/\/$/, "")}${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        signal: abort.signal,
      });
    } catch {
      if (signal?.aborted) throw signal.reason;
      throw new NyxError(`Could not reach ${getBaseUrl()}. Your session has not been cancelled.`, "network");
    }
    if (!response.ok) {
      let detail = "";
      try {
        const error = await response.json() as { detail?: unknown };
        if (typeof error.detail === "string") detail = error.detail;
        else if (Array.isArray(error.detail)) detail = "Invalid session request.";
      } catch { /* The HTTP status remains sufficient when a proxy returns HTML. */ }
      throw new NyxError(detail || `Session API returned HTTP ${response.status}.`,
        response.status === 401 ? "auth" : "api", response.status);
    }
    try { return await response.json() as T; }
    catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof SyntaxError) {
        throw new NyxError("Session API returned invalid JSON; the request outcome is uncertain.", "network");
      }
      throw new NyxError("Session response was interrupted. Your session has not been cancelled.", "network");
    }
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
  }
}

function path(sessionId: string, suffix = ""): string {
  return `${prefix}/${encodeURIComponent(sessionId)}${suffix}`;
}

export async function createSession(options: {
  budget?: number; target?: string; maxAgents?: number; requestId?: string; signal?: AbortSignal;
}): Promise<Session> {
  const semanticBody = {
    ...(options.budget === undefined ? {} : { budget_usd: options.budget }),
    ...(options.target === undefined ? {} : { target_id: options.target }),
    config: options.maxAgents === undefined ? {} : { max_active_agents: options.maxAgents },
  };
  // Persist before dispatch. A process restart after an uncertain response must
  // converge on the same authenticated-principal/server-scoped identity.
  const pending = prepareCreateSession(semanticBody, options.requestId);
  try {
    let session: Session;
    const firstAttempt = pending.beginAttempt();
    try { session = validateSessionAcknowledgement(await request("POST", prefix, pending.body, options.signal)); }
    catch (error) {
      if (!retryableTransportError(error)) {
        retireRejectedRequest(error, pending, firstAttempt);
        throw error;
      }
      const retryAttempt = pending.beginAttempt();
      try { session = validateSessionAcknowledgement(await request("POST", prefix, pending.body, options.signal)); }
      catch (retryError) {
        retireRejectedRequest(retryError, pending, retryAttempt);
        throw retryError;
      }
    }
    pending.acknowledge();
    return session;
  } catch (error) {
    pending.abandon();
    throw error;
  }
}

export async function getSession(sessionId: string, signal?: AbortSignal): Promise<Session> {
  return request("GET", path(sessionId), undefined, signal);
}

/** Resolve a local uncertain write without replaying it. */
export async function resolveOutboxReceipt(query: OutboxReceiptQuery,
  signal?: AbortSignal): Promise<OutboxReceiptState> {
  const parameters = new URLSearchParams();
  if (query.kind === "create-session") {
    parameters.set("request_id", query.identity);
    const receipt = await request<CreateRequestReceipt>(
      "GET",
      `${prefix}/receipts/create?${parameters.toString()}`,
      undefined,
      signal,
    );
    if (!receipt || !["committed", "not_committed"].includes(receipt.state)
      || (receipt.state === "committed") !== (typeof receipt.session_id === "string"
        && Boolean(receipt.session_id))) {
      throw new NyxError("Session API returned an invalid create receipt; local recovery state was retained.", "network");
    }
    return receipt.state;
  }
  if (!query.sessionId) return "unknown";
  parameters.set("message_id", query.identity);
  const receipt = await request<MessageRequestReceipt>(
    "GET",
    `${path(query.sessionId, "/receipts/message")}?${parameters.toString()}`,
    undefined,
    signal,
  );
  if (!receipt || !["committed", "not_committed", "unknown"].includes(receipt.state)) {
    throw new NyxError("Session API returned an invalid message receipt; local recovery state was retained.", "network");
  }
  const committed = receipt.state === "committed";
  if (committed !== (typeof receipt.completion_token === "string" && Boolean(receipt.completion_token)
    && Number.isSafeInteger(receipt.sequence) && (receipt.sequence ?? 0) >= 1)
    || (!committed && (receipt.completion_token != null || receipt.sequence != null))) {
    throw new NyxError("Session API returned inconsistent message receipt metadata; local recovery state was retained.", "network");
  }
  return receipt.state;
}

/** Request single-flight recovery after an operator advances a configured run. */
export async function resumeRun(runId: string, signal?: AbortSignal): Promise<RunResume> {
  if (!runId.trim()) throw new NyxError("Run ID must not be empty.", "config");
  const result = await request<RunResume>(
    "POST",
    `/v1/nyx/runs/${encodeURIComponent(runId)}/resume`,
    undefined,
    signal,
  );
  if (!result || result.run_id !== runId || typeof result.session_id !== "string"
    || !result.session_id || !["active", "pending", "dispatched"].includes(result.status)) {
    throw new NyxError(
      "Run recovery returned an invalid acknowledgement; the durable operator action remains recorded.",
      "network",
    );
  }
  return result;
}

export async function listAgents(sessionId: string, signal?: AbortSignal): Promise<SessionAgent[]> {
  const result = await request<SessionAgent[] | { agents: SessionAgent[] }>("GET", path(sessionId, "/agents"), undefined, signal);
  return Array.isArray(result) ? result : result.agents;
}

export async function listItems(sessionId: string, afterSequence: number, signal?: AbortSignal): Promise<ItemPage> {
  return request("GET", path(sessionId, `/items?after_sequence=${afterSequence}&limit=100`), undefined, signal);
}

export async function submitMessage(sessionId: string, text: string, agentPath: string,
  expectedTurnId: string | null, messageId?: string, responseTo?: string,
  signal?: AbortSignal): Promise<AcceptedMessage> {
  const semanticBody = { text, agent_path: agentPath, ...(responseTo ? { response_to: responseTo } : {}) };
  // The exact body is a short-lived local outbox record (0600) so recovery can
  // resend it byte-for-byte. It is removed only after a valid server ACK.
  const pending = prepareMessage(sessionId, semanticBody, expectedTurnId, messageId);
  try {
    let accepted: AcceptedMessage;
    const firstAttempt = pending.beginAttempt();
    try {
      accepted = validateMessageAcknowledgement(
        await request("POST", path(sessionId, "/messages"), pending.body, signal),
        sessionId,
        pending.body.message_id,
      );
    } catch (error) {
      // A lost response may already have committed the message. Retry with exactly
      // the same id and body; never transform a stale-turn conflict into a new turn.
      if (!retryableTransportError(error)) {
        retireRejectedRequest(error, pending, firstAttempt);
        throw error;
      }
      const retryAttempt = pending.beginAttempt();
      try {
        accepted = validateMessageAcknowledgement(
          await request("POST", path(sessionId, "/messages"), pending.body, signal),
          sessionId,
          pending.body.message_id,
        );
      } catch (retryError) {
        retireRejectedRequest(retryError, pending, retryAttempt);
        throw retryError;
      }
    }
    pending.acknowledge();
    return accepted;
  } catch (error) {
    pending.abandon();
    throw error;
  }
}

export async function listOperations(sessionId: string, accountId: string,
  signal?: AbortSignal): Promise<PendingOperation[]> {
  const result = await request<{ operations: PendingOperation[] }>("GET", path(sessionId, `/operations?account_id=${encodeURIComponent(accountId)}`), undefined, signal);
  return result.operations;
}

export async function reconcileOperation(sessionId: string, operationId: string,
  resolution: OperationResolution, accountId: string, signal?: AbortSignal): Promise<unknown> {
  return request("POST", path(sessionId, `/operations/${encodeURIComponent(operationId)}/reconcile`), { ...resolution, account_id: accountId }, signal);
}

export async function interruptAgent(sessionId: string, agentPath: string,
  expectedTurnId: string | null, expectedStateSequence: number | null = null,
  signal?: AbortSignal): Promise<unknown> {
  return request("POST", path(sessionId, "/interrupt"), {
    agent_path: agentPath, expected_turn_id: expectedTurnId,
    expected_state_sequence: expectedStateSequence,
  }, signal);
}
