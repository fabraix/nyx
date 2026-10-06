import { setTimeout as delay } from "node:timers/promises";
import {
  getSession,
  interruptAgent,
  listAgents,
  resumeRun,
  submitMessage,
} from "../api/session.js";
import { NyxError } from "../utils/errors.js";
import type { SessionEvent, SessionPanel, SessionViewState } from "./session-state.js";

export const sessionHelp = [
  "/status                       session and budget",
  "/agents · /use /root/child     inspect or select an agent",
  "/interrupt [agent]            interrupt a turn or stop an inactive child",
  "/memory [query]               ask the agent to recall durable memory",
  "/questions                    inspect pending questions",
  "/answer <request> <text>      reply to a specific request",
  "/approve <request>            record approval for a specific request",
  "/artifacts · /findings        inspect recorded outputs",
  "/transcript                   return to conversation",
  "/quit                         detach; agents continue server-side",
].join("\n");

type SessionAPI = { getSession: typeof getSession; listAgents: typeof listAgents; submitMessage: typeof submitMessage;
  interruptAgent: typeof interruptAgent;
  resumeRun: typeof resumeRun };

// A resume requested right after an answer may not be accepted on the first
// attempt. Retry only this causal user action, with a bounded backoff;
// ordinary session polling never calls the resume endpoint.
const configuredRunRecoveryDelaysMs = [
  250, 500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000, 15_000,
];

export function createSessionController(options: {
  state: () => SessionViewState; dispatch: (event: SessionEvent) => void; detach: () => void;
  signal?: AbortSignal;
  api?: SessionAPI;
}) {
  const api = options.api ?? {
    getSession,
    listAgents,
    submitMessage,
    interruptAgent,
    resumeRun,
  };
  const { dispatch } = options;
  const { signal } = options;
  const sessionId = options.state().session.session_id;
  const assertAttached = (): void => { signal?.throwIfAborted(); };
  async function agent(path: string) {
    assertAttached();
    const agents = signal ? await api.listAgents(sessionId, signal) : await api.listAgents(sessionId);
    dispatch({ type: "agents", agents });
    const selected = agents.find((entry) => entry.agent_path === path);
    if (!selected) throw new NyxError(`Agent not found: ${path}`, "config");
    return selected;
  }
  async function send(text: string, path = options.state().selectedAgent, responseTo?: string,
    messageId?: string) {
    const selected = await agent(path);
    const accepted = signal
      ? await api.submitMessage(sessionId, text, path, selected.active_turn_id ?? null,
        messageId, responseTo, signal)
      : await api.submitMessage(sessionId, text, path, selected.active_turn_id ?? null,
        messageId, responseTo);
    if (!accepted.completion_token || !Number.isSafeInteger(accepted.sequence) || accepted.sequence < 1) {
      throw new NyxError("Server accepted input without a durable completion token. Upgrade the server before continuing.", "api");
    }
    dispatch({ type: "accepted", message: accepted });
    return accepted;
  }
  const recoveryTasks = new Map<string, Promise<void>>();
  async function resumeConfiguredRun(runId: string): Promise<void> {
    try {
      for (let attempt = 0; ; attempt += 1) {
        assertAttached();
        const result = signal ? await api.resumeRun(runId, signal) : await api.resumeRun(runId);
        if (result.status === "active" || result.status === "dispatched") {
          dispatch({ type: "notice", text: "Operator action recorded; assessment recovery accepted." });
          return;
        }
        const recoveryDelay = configuredRunRecoveryDelaysMs[attempt];
        if (recoveryDelay === undefined) {
          dispatch({
            type: "notice",
            text: "Operator action recorded; the assessment will continue on its own.",
          });
          return;
        }
        await delay(recoveryDelay, undefined, { signal });
      }
    } catch (error) {
      if (signal?.aborted) return;
      // The answer is already recorded. A failed resume request must not
      // invite the user to repeat it; report that recovery is still pending.
      dispatch({
        type: "notice",
        text: `Operator action recorded; assessment recovery is pending (${error instanceof Error ? error.message : String(error)}).`,
        error: true,
      });
    }
  }
  function scheduleConfiguredRunRecovery(): void {
    const runId = options.state().session.run_id;
    if (typeof runId !== "string" || !runId.trim()) return;
    if (recoveryTasks.has(runId)) {
      dispatch({
        type: "notice",
        text: "Operator action recorded; assessment recovery is already running in the background.",
      });
      return;
    }
    dispatch({
      type: "notice",
      text: "Operator action recorded; assessment recovery is running in the background.",
    });
    let task: Promise<void>;
    task = resumeConfiguredRun(runId).finally(() => {
      if (recoveryTasks.get(runId) === task) recoveryTasks.delete(runId);
    });
    // Keeping the promise in this controller-owned registry makes recovery a
    // lifecycle task rather than a detached promise. `drain()` observes it on
    // shutdown after the shared attachment signal has cancelled its backoff.
    recoveryTasks.set(runId, task);
  }
  async function drain(): Promise<void> {
    while (recoveryTasks.size) {
      await Promise.allSettled([...recoveryTasks.values()]);
    }
  }
  async function command(line: string): Promise<void> {
    assertAttached();
    const text = line.trim();
    if (!text) return;
    if (!text.startsWith("/")) { await send(line); return; }
    const space = text.indexOf(" ");
    const name = space === -1 ? text : text.slice(0, space);
    const args = space === -1 ? "" : text.slice(space + 1).trim();
    if (name === "/quit" || name === "/exit") { options.detach(); return; }
    if (name === "/status") {
      dispatch({ type: "session", session: signal
        ? await api.getSession(sessionId, signal)
        : await api.getSession(sessionId) });
      dispatch({ type: "panel", panel: "status" }); return;
    }
    if (name === "/agents") {
      dispatch({ type: "agents", agents: signal
        ? await api.listAgents(sessionId, signal)
        : await api.listAgents(sessionId) });
      dispatch({ type: "panel", panel: "agents" }); return;
    }
    if (name === "/use") {
      await agent(args);
      dispatch({ type: "select_agent", agentPath: args }); return;
    }
    if (name === "/interrupt") {
      const selected = await agent(args || options.state().selectedAgent);
      const activeTurn = selected.active_turn_id ?? null;
      if (activeTurn === null && (!Number.isSafeInteger(selected.state_sequence)
        || (selected.state_sequence as number) < 0)) {
        throw new NyxError("Server omitted the inactive agent state token. Refresh after upgrading the server.", "api");
      }
      if (signal) {
        await api.interruptAgent(sessionId, selected.agent_path, activeTurn,
          activeTurn === null ? selected.state_sequence as number : null, signal);
      } else {
        await api.interruptAgent(sessionId, selected.agent_path, activeTurn,
          activeTurn === null ? selected.state_sequence as number : null);
      }
      dispatch({ type: "notice", text: activeTurn
        ? `Interruption requested for ${selected.agent_path}.`
        : `Stop requested for ${selected.agent_path}.` });
      return;
    }
    if (name === "/memory") {
      await send(`Check your durable memory${args ? ` for: ${args}` : ". Summarize relevant entries and their scope."}`); return;
    }
    if (name === "/answer" || name === "/approve") {
      const split = args.indexOf(" ");
      const ref = split === -1 ? args : args.slice(0, split);
      const answer = name === "/approve" ? "Approved." : (split === -1 ? "" : args.slice(split + 1).trim());
      const question = options.state().questions.find((item) => item.ref === ref || String(item.sequence) === ref);
      if (!question || !answer) throw new NyxError("Use /questions to select a pending request, then /answer <request> <text> or /approve <request>.", "config");
      if (!question.ref) throw new NyxError("The server omitted this request's durable ID; refresh after upgrading the server.", "api");
      await send(answer, question.agent_path ?? "/root", question.ref);
      scheduleConfiguredRunRecovery();
      return;
    }
    const panels: Record<string, SessionPanel> = {
      "/questions": "questions", "/artifacts": "artifacts", "/findings": "findings",
      "/help": "help", "/transcript": "transcript",
    };
    if (panels[name]) { dispatch({ type: "panel", panel: panels[name] }); return; }
    throw new NyxError("Unknown command. Use /help, or enter a message.", "config");
  }
  return { send, command, drain };
}
