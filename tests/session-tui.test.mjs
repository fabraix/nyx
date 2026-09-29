import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import React from "react";
import { render, cleanup } from "ink-testing-library";
import {
  initialSessionState,
  reduceSession,
  budgetText,
  MAX_RENDER_ITEMS,
  MAX_TERMINAL_RECEIPTS,
} from "../dist/ui/session-state.js";
import { createSessionController } from "../dist/ui/session-controller.js";
import { SessionScreen, panelText } from "../dist/ui/session-tui.js";
import { sessionEvents } from "../dist/api/session-events.js";
import { NyxError } from "../dist/utils/errors.js";
import { terminalField, terminalText } from "../dist/utils/terminal.js";
import { createCommandQueue } from "../dist/commands/tui.js";

const session = { session_id: "fixture", status: "idle", budget: { spent_usd: 0.24, budget_usd: 5 } };
const accepted = { sequence: 1, completion_token: "input-1", session_id: "fixture", message_id: "message-1", queued: true };
const item = (sequence, kind, payload = {}, extra = {}) => ({ sequence, kind, payload, agent_path: "/root", ref: `item-${sequence}`, ...extra });

test("reducer keeps accepted input pending through stale idle and unrelated terminals, replays idempotently", () => {
  let state = initialSessionState(session);
  state = reduceSession(state, { type: "accepted", message: accepted });
  state = reduceSession(state, { type: "session", session });
  assert.equal(state.pending["input-1"], true);
  state = reduceSession(state, { type: "item", item: item(2, "input_terminal", { status: "idle", completion_token: "other" }) });
  assert.equal(state.pending["input-1"], true);
  const terminal = { type: "item", item: item(3, "input_terminal", { status: "waiting" }, { correlation_id: "input-1" }) };
  state = reduceSession(state, terminal);
  assert.deepEqual(state.pending, {});
  assert.equal(state.terminals["input-1"], "waiting");
  assert.equal(reduceSession(state, terminal), state);
  assert.equal(reduceSession(state, { type: "accepted", message: accepted }), state, "Delayed HTTP ACK cannot reopen a completed input");
  assert.equal(budgetText(state.session), "$0.24 / $5.00");
});

test("structural terminal identity survives redaction of the display payload", () => {
  const completionToken = "input_owned-hash";
  let state = initialSessionState(session);
  state = reduceSession(state, { type: "accepted", message: { ...accepted, completion_token: completionToken } });
  state = reduceSession(state, { type: "item", item: item(2, "input_terminal", {
    status: "idle", completion_token: "[redacted]_owned-hash",
  }, { correlation_id: completionToken }) });
  assert.deepEqual(state.pending, {});
  assert.equal(state.terminals[completionToken], "idle");
  assert.equal(state.terminals["[redacted]_owned-hash"], undefined);
});

test("questions belong to agents and survive unrelated input", () => {
  let state = initialSessionState(session);
  state = reduceSession(state, { type: "item", item: item(1, "question", { text: "Which tenant?" }, { agent_path: "/root/recon" }) });
  state = reduceSession(state, { type: "item", item: item(2, "user_message", { text: "Continue" }) });
  assert.equal(state.questions.length, 1);
  state = reduceSession(state, { type: "item", item: item(3, "user_message", { text: "Owned test tenant", response_to: "item-1" }, { agent_path: "/root/recon" }) });
  assert.equal(state.questions.length, 0);
});

test("question replies clear only their durable reference and snapshots are authoritative across replay", () => {
  let state = initialSessionState(session);
  state = reduceSession(state, { type: "item", item: item(1, "question", { text: "First?" }) });
  state = reduceSession(state, { type: "item", item: item(2, "question", { text: "Second?" }) });
  state = reduceSession(state, { type: "item", item: item(3, "user_message", { text: "What is the status?" }) });
  assert.deepEqual(state.questions.map(q => q.ref), ["item-1", "item-2"]);
  state = reduceSession(state, { type: "item", item: item(4, "user_message", { text: "Yes", response_to: "item-1" }) });
  assert.deepEqual(state.questions.map(q => q.ref), ["item-2"]);
  state = reduceSession(state, { type: "session", session: { ...session, pending_questions: [], pending_questions_sequence: 8 } });
  assert.deepEqual(state.questions, []);
  state = reduceSession(state, { type: "item", item: item(5, "question", { text: "Already resolved elsewhere" }) });
  assert.deepEqual(state.questions, [], "Old transcript cannot resurrect a resolved question");
  state = reduceSession(state, { type: "item", item: item(9, "question", { text: "New question" }) });
  state = reduceSession(state, { type: "session", session: { ...session, pending_questions: [], pending_questions_sequence: 8 } });
  assert.equal(state.questions[0].ref, "item-9", "Stale replica snapshot cannot clear a newer request");
  state = reduceSession(state, { type: "item", item: item(10, "question_resolved", {
    response_to: "[redacted]",
  }, { correlation_id: "item-9", ref: "resolved_item-9" }) });
  assert.deepEqual(state.questions, []);

  state = reduceSession(state, { type: "item", item: item(11, "question", { text: "Stopped child?" }) });
  state = reduceSession(state, { type: "item", item: item(12, "question_resolved", {
    response_to: "[redacted]",
  }, { ref: "resolved_item-11" }) });
  assert.deepEqual(state.questions, [], "Resolution item identity is the fallback when correlation is absent");
});

test("a polling attachment never resumes agents even after many recovery intervals", async () => {
  const previous = Date.now;
  let clock = 0, reads = 0, mutations = 0;
  Date.now = () => clock;
  try {
    const source = { getSession: async () => { clock += 60_000; return { ...session, status: "interrupted" }; },
      listItems: async () => ({ items: [], next_sequence: 0 }),
      resumeSession: async () => { mutations++; return session; } };
    for await (const event of sessionEvents("fixture", { after: 0, signal: new AbortController().signal, source, pollMs: 1 })) {
      if (event.type === "cursor" && ++reads === 3) break;
    }
    assert.equal(mutations, 0);
  } finally { Date.now = previous; }
});

test("HTTP500 reconnects from the last durable cursor instead of ending the stream", async () => {
  let calls = 0;
  const source = { getSession: async () => { if (++calls === 1) throw new NyxError("temporary", "api", 500); return session; },
    listItems: async (_id, after) => ({ items: [], next_sequence: after }) };
  const events = [];
  for await (const event of sessionEvents("fixture", { after: 12, source, signal: new AbortController().signal, pollMs: 1 })) {
    events.push(event);
    if (event.type === "cursor") break;
  }
  assert.deepEqual(events.filter(event => event.type === "connection").map(event => event.status), ["reconnecting", "connected"]);
  assert.equal(events.at(-1).sequence, 12);
});

test("terminal sanitization removes control instructions while retaining ordinary multiline prose", () => {
  assert.equal(
    terminalText("a\r\b\0\x07\x1b[2J\x9b\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u206a\u206b\u206c\u206d\u206e\u206fb\n\tc"),
    "ab\n\tc",
  );
  assert.equal(terminalField("a\n\tb"), "a  b");
});

test("scroll clamps to visible transcript and never exposes an empty history page", async () => {
  const state = initialSessionState(session);
  state.items = [...Array.from({ length: 10 }, (_, index) => item(index + 1, "assistant_message", { text: `Visible message ${index + 1}` })),
    ...Array.from({ length: 30 }, (_, index) => item(index + 11, "agent_status", { status: "idle" }))];
  const ui = render(React.createElement(SessionScreen, { state, onSubmit() {}, onDetach() {}, onClosePanel() {} }));
  try {
    await delay(30);
    for (let count = 0; count < 5; count++) { ui.stdin.write("\u001b[5~"); await delay(20); }
    assert.match(ui.lastFrame(), /Visible message 1/);
    assert.doesNotMatch(ui.lastFrame(), /Ask a question/);
    assert.match(ui.lastFrame(), /PgUp\/PgDn transcript/);
  } finally { ui.unmount(); cleanup(); }
});

test("attached render state is bounded while cursor, pending input, and final verdict survive", async () => {
  let state = initialSessionState(session);
  state = reduceSession(state, { type: "accepted", message: accepted });
  state = reduceSession(state, { type: "item", item: item(1, "assessment_completed", { result: "EXHAUSTED" }) });
  for (let sequence = 2; sequence <= MAX_RENDER_ITEMS + 200; sequence++) {
    state = reduceSession(state, { type: "item", item: item(sequence, "assistant_message", { text: `Message ${sequence}` }) });
  }
  assert.equal(state.items.length, MAX_RENDER_ITEMS);
  assert.equal(state.items[0].sequence, 201);
  assert.equal(state.sequence, MAX_RENDER_ITEMS + 200);
  assert.equal(state.pending["input-1"], true);
  assert.equal(state.verdict.sequence, 1);
  assert.equal(state.verdict.payload.result, "EXHAUSTED");

  const verdictUi = render(React.createElement(SessionScreen, {
    state, onSubmit() {}, onDetach() {}, onClosePanel() {},
  }));
  try {
    await delay(20);
    const frame = verdictUi.lastFrame();
    assert.match(frame, /Assessment verdict: EXHAUSTED/);
    assert.match(frame, new RegExp(`Message ${MAX_RENDER_ITEMS + 200}`));
    assert.ok(frame.indexOf("Assessment verdict:") < frame.indexOf("Message "),
      "the retained verdict is pinned outside chronological scrollback");
    assert.doesNotMatch(frame, /assessment completed/,
      "an evicted verdict is not spliced back into transcript history");
  } finally { verdictUi.unmount(); cleanup(); }

  for (let sequence = MAX_RENDER_ITEMS + 201; sequence <= MAX_RENDER_ITEMS + 201 + MAX_TERMINAL_RECEIPTS; sequence++) {
    state = reduceSession(state, { type: "item", item: item(sequence, "input_terminal", {
      status: "idle", completion_token: `other-${sequence}`,
    }) });
  }
  assert.equal(Object.keys(state.terminals).length, MAX_TERMINAL_RECEIPTS);
  assert.equal(state.pending["input-1"], true, "unresolved input identities are never evicted");

  const longText = `${"x".repeat(4_001)}END-OF-MESSAGE`;
  state = initialSessionState(session);
  state = reduceSession(state, { type: "item", item: item(1, "assistant_message", { text: longText }) });
  const ui = render(React.createElement(SessionScreen, { state, onSubmit() {}, onDetach() {}, onClosePanel() {} }));
  try {
    await delay(20);
    assert.match(ui.lastFrame(), /END-OF-MESSAGE/);
  } finally { ui.unmount(); cleanup(); }
});

test("artifact panel renders response artifacts from the loaded transcript", () => {
  let state = initialSessionState(session);
  state = reduceSession(state, { type: "item", item: item(1, "response_artifact", {
    content: "full response body", offset: 0, total_chars: 18, sha256: "digest",
  }) });
  assert.match(panelText({ ...state, panel: "artifacts" }), /full response body/);
});

test("agents panel preserves complete child tasks", () => {
  const state = initialSessionState(session);
  const task = `${"inspect every route; ".repeat(20)}END-OF-CHILD-TASK`;
  state.agents = [{ agent_path: "/root/recon", status: "running", task }];
  assert.match(panelText({ ...state, panel: "agents" }), /END-OF-CHILD-TASK/);
});

test("event source reconnects at durable cursor, drains suppressed pages and does not redispatch input", async () => {
  const abort = new AbortController();
  const afters = [];
  let reads = 0;
  const source = {
    getSession: async () => session,
    resumeSession: async () => { throw new Error("Read-only reconnect must not redispatch"); },
    listItems: async (_id, after) => {
      afters.push(after);
      reads += 1;
      if (reads === 1) return { items: [item(1, "assistant_message", { text: "first" })], next_sequence: 1 };
      if (reads === 2) throw new NyxError("connection reset", "network");
      if (after === 1) return { items: [], next_sequence: 5 };
      if (after === 5) return { items: [item(6, "input_terminal", { status: "idle", completion_token: "input-1" })], next_sequence: 6 };
      return { items: [], next_sequence: after };
    },
  };
  const events = [];
  for await (const event of sessionEvents("fixture", { after: 0, source, signal: abort.signal, pollMs: 1 })) {
    events.push(event);
    if (event.type === "cursor" && event.sequence === 6) break;
  }
  assert.deepEqual(events.filter((event) => event.type === "item").map((event) => event.item.sequence), [1, 6]);
  assert.deepEqual(events.filter((event) => event.type === "connection").map((event) => event.status), ["reconnecting", "connected"]);
  assert.deepEqual(afters, [0, 1, 1, 5, 6]);
  assert.equal(events.at(-1).type, "cursor");
  assert.equal(events.at(-1).sequence, 6);
});

test("detaching aborts an in-flight status read without cancelling server work", async () => {
  const abort = new AbortController();
  const source = {
    getSession: async (_session, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    listItems: async () => { throw new Error("Unexpected read"); },
    resumeSession: async () => { throw new Error("Unexpected mutation"); },
  };
  const stream = sessionEvents("fixture", { after: 0, signal: abort.signal, source });
  const pending = stream.next();
  abort.abort();
  assert.deepEqual(await pending, { value: undefined, done: true });
});

test("controller binds answer and interruption to selected child and fresh turn", async () => {
  let state = initialSessionState(session);
  state = reduceSession(state, { type: "item", item: item(1, "question", { text: "May I use the test tenant?" }, { agent_path: "/root/recon" }) });
  const calls = [];
  const api = {
    listAgents: async () => [{ agent_path: "/root", status: "idle", active_turn_id: null }, { agent_path: "/root/recon", status: "running", active_turn_id: "fresh-turn" }],
    submitMessage: async (...args) => { calls.push(["send", ...args]); return accepted; },
    interruptAgent: async (...args) => { calls.push(["interrupt", ...args]); },
    getSession: async () => session,
    listOperations: async () => [],
    reconcileOperation: async () => { throw new Error("Unexpected reconciliation"); },
    resumeRun: async () => { throw new Error("Ordinary sessions must not resume a run"); },
  };
  let detached = false;
  const controller = createSessionController({ state: () => state, dispatch: (event) => { state = reduceSession(state, event); }, detach: () => { detached = true; }, api });
  await controller.command("/approve item-1");
  assert.equal(calls[0][2], "Approved.");
  assert.equal(calls[0][3], "/root/recon");
  assert.equal(calls[0][4], "fresh-turn");
  assert.equal(calls[0][6], "item-1");
  await controller.command("/use /root/recon");
  assert.equal(state.selectedAgent, "/root/recon");
  await controller.command("/interrupt");
  assert.deepEqual(calls[1], ["interrupt", "fixture", "/root/recon", "fresh-turn", null]);
  await controller.command("/quit");
  assert.equal(detached, true);
  assert.equal(calls.length, 2, "Detach has no cancellation effect");
});

test("controller stops the exact inactive child state generation", async () => {
  let state = initialSessionState(session);
  const calls = [];
  const api = {
    listAgents: async () => [
      { agent_path: "/root", status: "idle", active_turn_id: null, state_sequence: 2 },
      { agent_path: "/root/recon", status: "waiting", active_turn_id: null, state_sequence: 17 },
    ],
    interruptAgent: async (...args) => { calls.push(args); },
    getSession: async () => session,
    submitMessage: async () => accepted,
    listOperations: async () => [],
    reconcileOperation: async () => { throw new Error("Unexpected reconciliation"); },
    resumeRun: async () => { throw new Error("Ordinary sessions must not resume a run"); },
  };
  const controller = createSessionController({
    state: () => state,
    dispatch: (event) => { state = reduceSession(state, event); },
    detach: () => {},
    api,
  });
  await controller.command("/interrupt /root/recon");
  assert.deepEqual(calls, [["fixture", "/root/recon", null, 17]]);
  assert.equal(state.notice.text, "Stop requested for /root/recon.");
});

test("controller refuses an unfenced inactive stop from an old server", async () => {
  let calls = 0;
  const state = initialSessionState(session);
  const controller = createSessionController({
    state: () => state,
    dispatch: () => {},
    detach: () => {},
    api: {
      listAgents: async () => [
        { agent_path: "/root/recon", status: "waiting", active_turn_id: null },
      ],
      interruptAgent: async () => { calls++; },
      getSession: async () => session,
      submitMessage: async () => accepted,
      listOperations: async () => [],
      reconcileOperation: async () => {},
      resumeRun: async () => { throw new Error("Ordinary sessions must not resume a run"); },
    },
  });
  await assert.rejects(controller.command("/interrupt /root/recon"), /inactive agent state token/);
  assert.equal(calls, 0);
});

test("configured-run operator actions retry a pending supervisor recovery in a tracked background task", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nyx-controller-recovery-"));
  const resolutionFile = join(directory, "resolution.json");
  writeFileSync(resolutionFile, JSON.stringify({
    action: "confirmed_not_dispatched",
    resolution_id: "operator-proof",
    evidence_refs: ["provider-log:fixture"],
  }));
  let state = initialSessionState({
    ...session,
    run_id: "run-1",
    account_id: "account-1",
  });
  state = reduceSession(state, {
    type: "item",
    item: item(1, "question", { text: "Continue?" }),
  });
  const calls = [];
  let resumeAttempts = 0;
  const api = {
    listAgents: async () => [
      { agent_path: "/root", status: "waiting", active_turn_id: null },
    ],
    submitMessage: async () => accepted,
    interruptAgent: async () => {},
    getSession: async () => state.session,
    listOperations: async () => [],
    reconcileOperation: async (...args) => { calls.push(["reconcile", ...args]); },
    resumeRun: async (...args) => {
      calls.push(["resume", ...args]);
      resumeAttempts += 1;
      return {
        run_id: "run-1",
        session_id: "fixture",
        status: resumeAttempts === 1
          ? "pending"
          : resumeAttempts === 2
            ? "active"
            : "dispatched",
      };
    },
  };
  const controller = createSessionController({
    state: () => state,
    dispatch: (event) => { state = reduceSession(state, event); },
    detach: () => {},
    api,
  });
  try {
    await controller.command("/approve item-1");
    assert.deepEqual(calls, [
      ["resume", "run-1"],
    ], "the durable operator command returns during recovery backoff");
    await controller.drain();
    assert.deepEqual(calls, [
      ["resume", "run-1"],
      ["resume", "run-1"],
    ]);

    await controller.command(`/reconcile operation-1 ${resolutionFile}`);
    await controller.drain();
    assert.equal(calls[2][0], "reconcile");
    assert.equal(calls[2][1], "fixture");
    assert.equal(calls[2][2], "operation-1");
    assert.equal(calls[2][4], "account-1");
    assert.deepEqual(calls[3], ["resume", "run-1"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("configured-run recovery is single-flight, does not block queued status, and drains on detach", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nyx-controller-single-flight-"));
  const resolutionFile = join(directory, "resolution.json");
  writeFileSync(resolutionFile, JSON.stringify({
    action: "confirmed_not_dispatched",
    resolution_id: "operator-proof",
    evidence_refs: ["provider-log:fixture"],
  }));
  const abort = new AbortController();
  let state = initialSessionState({
    ...session, run_id: "run-abort", account_id: "account-1",
  });
  state = reduceSession(state, {
    type: "item",
    item: item(1, "question", { text: "Continue?" }),
  });
  const calls = [];
  const controller = createSessionController({
    state: () => state,
    dispatch: (event) => { state = reduceSession(state, event); },
    detach: () => abort.abort(),
    signal: abort.signal,
    api: {
      listAgents: async () => [{ agent_path: "/root", status: "waiting", active_turn_id: null }],
      submitMessage: async () => { calls.push("answer"); return accepted; },
      interruptAgent: async () => {},
      getSession: async () => { calls.push("status"); return state.session; },
      listOperations: async () => { calls.push("operations"); return []; },
      reconcileOperation: async () => { calls.push("reconcile"); },
      resumeRun: async (_runId, signal) => {
        calls.push("resume");
        assert.equal(signal, abort.signal);
        return { run_id: "run-abort", session_id: "fixture", status: "pending" };
      },
    },
  });
  const queue = createCommandQueue({
    signal: abort.signal,
    execute: controller.command,
    onError: (error) => { throw error; },
  });
  try {
    queue.submit("/approve item-1");
    queue.submit(`/reconcile operation-1 ${resolutionFile}`);
    queue.submit("/status");
    await Promise.race([
      (async () => { while (!calls.includes("status")) await delay(1); })(),
      delay(100).then(() => { throw new Error("recovery backoff blocked the command queue"); }),
    ]);
    assert.equal(calls.filter((call) => call === "resume").length, 1,
      "operator triggers for the same run share one recovery task");
    assert.ok(calls.includes("answer"));
    assert.ok(calls.includes("reconcile"));
  } finally {
    abort.abort();
    await Promise.race([
      Promise.all([queue.drain(), controller.drain()]),
      delay(100).then(() => { throw new Error("aborted recovery lifecycle did not drain"); }),
    ]);
    rmSync(directory, { recursive: true, force: true });
  }
  assert.notEqual(state.notice?.error, true,
    "local detach is not reported as a failed durable action");
});

test("detaching settles the awaited command chain and drops queued commands", async () => {
  const abort = new AbortController();
  const executed = [];
  const queue = createCommandQueue({
    signal: abort.signal,
    execute: async (line) => {
      executed.push(line);
      await delay(60_000, undefined, { signal: abort.signal });
    },
    onError: (error) => { throw error; },
  });
  queue.submit("running");
  queue.submit("must-not-start");
  while (executed.length === 0) await delay(1);
  abort.abort();
  await Promise.race([
    queue.drain(),
    delay(100).then(() => { throw new Error("aborted command queue did not drain"); }),
  ]);
  assert.deepEqual(executed, ["running"]);
});

test("controller fails visibly when server omits causal completion contract", async () => {
  const state = initialSessionState(session);
  const controller = createSessionController({ state: () => state, dispatch: () => {}, detach: () => {}, api: {
    listAgents: async () => [{ agent_path: "/root" }], submitMessage: async () => ({ queued: true }),
  } });
  await assert.rejects(controller.send("hello"), /without a durable completion token/);
});

test("Ink screen accepts edited input, shows contextual requests and detaches on Ctrl-C", async () => {
  const submitted = [];
  let detached = false;
  let closed = false;
  let state = initialSessionState(session);
  const props = { state, onSubmit: (line) => submitted.push(line), onDetach: () => { detached = true; }, onClosePanel: () => { closed = true; } };
  const ui = render(React.createElement(SessionScreen, props));
  try {
    await delay(30);
    assert.match(ui.lastFrame(), /Nyx/);
    assert.match(ui.lastFrame(), /\$0.24 \/ \$5.00/);
    ui.stdin.write("helo"); await delay(20);
    ui.stdin.write("\u001b[D"); await delay(20);
    ui.stdin.write("l"); await delay(20);
    ui.stdin.write("\r"); await delay(20);
    assert.deepEqual(submitted, ["hello"]);
    ui.stdin.write("\u001b[A"); await delay(20);
    assert.match(ui.lastFrame(), /hello/);
    state = reduceSession(state, { type: "item", item: item(1, "question", { text: "Which owned tenant?" }) });
    state = reduceSession(state, { type: "panel", panel: "questions" });
    ui.rerender(React.createElement(SessionScreen, { ...props, state })); await delay(20);
    assert.match(ui.lastFrame(), /Which owned tenant/);
    ui.stdin.write("\u001b"); await delay(20);
    assert.equal(closed, true);
    ui.stdin.write("\u0003"); await delay(20);
    assert.equal(detached, true);
  } finally { ui.unmount(); cleanup(); }
});

test("terminal content cannot inject ANSI or OSC control sequences", () => {
  let state = initialSessionState(session);
  state = reduceSession(state, { type: "item", item: item(1, "assistant_message", { text: "safe\u001b]52;c;c2VjcmV0\u0007\u001b[2Jdone" }) });
  const ui = render(React.createElement(SessionScreen, { state, onSubmit() {}, onDetach() {}, onClosePanel() {} }));
  try {
    assert.match(ui.lastFrame(), /safedone/);
    assert.doesNotMatch(ui.lastFrame(), /52;c|c2VjcmV0/);
    assert.match(panelText({ ...state, panel: "artifacts" }), /No artifacts recorded/);
  } finally { ui.unmount(); cleanup(); }
});
