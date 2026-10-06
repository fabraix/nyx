import type { AcceptedMessage, Session, SessionAgent, SessionItem } from "../api/session.js";

export type SessionPanel = "transcript" | "status" | "agents" | "questions" | "artifacts" | "findings" | "help";
export type SessionEvent =
  | { type: "session"; session: Session }
  | { type: "item"; item: SessionItem }
  | { type: "cursor"; sequence: number }
  | { type: "accepted"; message: AcceptedMessage }
  | { type: "agents"; agents: SessionAgent[] }
  | { type: "select_agent"; agentPath: string }
  | { type: "panel"; panel: SessionPanel }
  | { type: "connection"; status: "connected" | "reconnecting"; message?: string }
  | { type: "notice"; text: string; error?: boolean };

export interface SessionViewState {
  session: Session;
  sequence: number;
  items: SessionItem[];
  questions: SessionItem[];
  questionsSequence: number;
  agents: SessionAgent[];
  selectedAgent: string;
  panel: SessionPanel;
  connection: "connected" | "reconnecting";
  notice?: { text: string; error?: boolean };
  pending: Record<string, true>;
  terminals: Record<string, string>;
  /** Latest durable assessment verdict, retained even after transcript eviction. */
  verdict?: SessionItem;
}

// The server remains the complete durable transcript. An attached terminal is
// only a projection and must stay flat-memory over multi-day assessments.
export const MAX_RENDER_ITEMS = 512;
export const MAX_TERMINAL_RECEIPTS = 256;

function latest<T>(values: T[], limit: number): T[] {
  return values.length <= limit ? values : values.slice(-limit);
}

function boundedTerminals(values: Record<string, string>): Record<string, string> {
  const entries = Object.entries(values);
  return entries.length <= MAX_TERMINAL_RECEIPTS
    ? values
    : Object.fromEntries(entries.slice(-MAX_TERMINAL_RECEIPTS));
}

export function initialSessionState(session: Session, sequence = 0): SessionViewState {
  return { session, sequence, items: [], questions: session.pending_questions ?? [],
    questionsSequence: session.pending_questions_sequence ?? 0, agents: [], selectedAgent: "/root",
    panel: "transcript", connection: "connected", pending: {}, terminals: {} };
}

export function terminalToken(item: SessionItem): string | undefined {
  // correlation_id is the structural accepted-input identity and wins over the
  // payload copy when both are present.
  const token = item.correlation_id ?? item.payload.completion_token;
  return typeof token === "string" ? token : undefined;
}

export function questionResolutionRef(item: SessionItem): string | undefined {
  // Answered/reconciled questions carry the canonical question item as their
  // structural correlation. Agent-stop resolutions use the immutable
  // `resolved_${questionId}` item identity. Payload references are the final
  // fallback.
  const structural = item.correlation_id ?? (
    typeof item.ref === "string" && item.ref.startsWith("resolved_")
      ? item.ref.slice("resolved_".length)
      : undefined
  );
  const ref = structural ?? item.payload.response_to ?? item.payload.question_ref;
  return typeof ref === "string" ? ref : undefined;
}

/** Durable items are authoritative; UI actions never manufacture a successful turn. */
export function reduceSession(state: SessionViewState, event: SessionEvent): SessionViewState {
  switch (event.type) {
    case "session": {
      const sequence = event.session.pending_questions_sequence;
      const current = Number.isSafeInteger(sequence) && sequence! >= state.questionsSequence
        && Array.isArray(event.session.pending_questions);
      return { ...state, session: event.session, ...(current ? {
        questions: event.session.pending_questions!, questionsSequence: sequence!,
      } : {}) };
    }
    case "agents": return { ...state, agents: event.agents };
    case "select_agent": return { ...state, selectedAgent: event.agentPath, panel: "transcript" };
    case "panel": return { ...state, panel: event.panel };
    case "notice": return { ...state, notice: { text: event.text, error: event.error } };
    case "connection": return { ...state, connection: event.status,
      notice: event.status === "connected" ? undefined : { text: event.message ?? "Reconnecting…" } };
    case "cursor": return event.sequence <= state.sequence ? state : { ...state, sequence: event.sequence };
    case "accepted": {
      const token = event.message.completion_token;
      return state.terminals[token] ? state : { ...state, pending: { ...state.pending, [token]: true } };
    }
    case "item": {
      const item = event.item;
      if (item.sequence <= state.sequence) return state;
      let questions = state.questions;
      let questionsSequence = state.questionsSequence;
      // A fresh authoritative snapshot can precede older paged transcript items.
      // Replaying those items must not resurrect already resolved requests.
      if (item.sequence > questionsSequence) {
        if (item.kind === "question") {
          questions = [...questions, item];
          questionsSequence = item.sequence;
        }
        if (item.kind === "user_message" || item.kind === "question_resolved") {
          const ref = item.kind === "question_resolved"
            ? questionResolutionRef(item)
            : item.payload.response_to ?? item.payload.question_ref;
          if (typeof ref === "string") {
            questions = questions.filter((question) => question.ref !== ref);
            questionsSequence = item.sequence;
          }
        }
      }
      let pending = state.pending;
      let terminals = state.terminals;
      const token = item.kind === "input_terminal" ? terminalToken(item) : undefined;
      if (token) {
        pending = { ...pending };
        delete pending[token];
        terminals = boundedTerminals({ ...terminals, [token]: String(item.payload.status) });
      }
      return { ...state, sequence: item.sequence, questions, questionsSequence, pending, terminals,
        // Exact older pages remain server-side and can be reopened by cursor;
        // keeping the terminal projection bounded prevents a long attachment
        // from retaining an unbounded React tree and payload graph.
        items: latest([...state.items, item], MAX_RENDER_ITEMS),
        ...(item.kind === "assessment_completed" ? { verdict: item } : {}) };
    }
  }
}

export function itemText(item: SessionItem): string {
  const value = item.payload.text ?? item.payload.content ?? item.payload.message;
  if (typeof value === "string") return value;
  if (item.kind === "tool_intent" || item.kind === "tool_result") {
    return `${item.payload.name ?? "tool"} ${item.kind === "tool_intent" ? "running" : "finished"}`;
  }
  return item.kind.replaceAll("_", " ");
}

export function budgetText(session: Session): string {
  const budget = session.budget as Record<string, unknown> | undefined;
  const spent = budget?.spent_usd ?? budget?.settled_usd ?? session.spent_usd;
  const cap = budget?.budget_usd ?? session.budget_usd;
  const amount = typeof spent === "number" ? `$${spent.toFixed(2)}` : "cost pending";
  return typeof cap === "number" ? `${amount} / $${cap.toFixed(2)}` : amount;
}
