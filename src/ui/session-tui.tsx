import React, { useEffect, useState } from "react";
import { Box, Text, render, useInput } from "ink";
import { terminalField, terminalText as clean } from "../utils/terminal.js";
import type { SessionViewState } from "./session-state.js";
import { budgetText, itemText } from "./session-state.js";
import { sessionHelp } from "./session-controller.js";

export interface SessionScreenProps {
  state: SessionViewState;
  onSubmit: (line: string) => void;
  onDetach: () => void;
  onClosePanel: () => void;
}

export function panelText(state: SessionViewState): string | undefined {
  switch (state.panel) {
    case "transcript": return undefined;
    case "help": return sessionHelp;
    case "status": return JSON.stringify(state.session, null, 2);
    case "agents": return state.agents.map((agent) =>
      `${agent.agent_path === state.selectedAgent ? "›" : " "} ${agent.agent_path}  ${agent.status}${agent.task ? `\n    ${String(agent.task)}` : ""}`).join("\n\n") || "No agents reported yet.";
    case "questions": return state.questions
      .map((item) => `${item.ref ?? item.sequence}  ${item.agent_path}\n${itemText(item)}`).join("\n\n") || "No pending requests.";
    case "reconcile": return state.operations.map((operation) =>
      `${operation.operation_id}  ${operation.tool_name ?? operation.kind}  ${operation.supported ? "resolution supported" : "domain-specific recovery required"}`)
      .join("\n") || "No unresolved operations.";
    case "artifacts":
    case "findings": return state.items.filter((item) => item.kind.includes(state.panel === "artifacts" ? "artifact" : "finding"))
      .map((item) => JSON.stringify(item.payload, null, 2)).join("\n\n") || `No ${state.panel} recorded in the loaded transcript.`;
  }
}

/** A terminal view only: all commands and lifecycle decisions remain outside React. */
export function SessionScreen({ state, onSubmit, onDetach, onClosePanel }: SessionScreenProps) {
  const [input, setInput] = useState("");
  const [position, setPosition] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | undefined>();
  const [scroll, setScroll] = useState(0);
  // The durable verdict is retained independently of the bounded transcript.
  // Keep it pinned as status instead of re-inserting an evicted old item at
  // the beginning of otherwise chronological scrollback.
  const transcript = state.items.filter((item) => ![
    "input_terminal", "agent_status", "question_resolved", "assessment_completed",
  ].includes(item.kind));
  const maxScroll = Math.max(0, transcript.length - 8);
  useInput((value, key) => {
    if ((key.ctrl && value === "c") || (key.ctrl && value === "d" && !input)) { onDetach(); return; }
    if (key.escape) { onClosePanel(); return; }
    if (key.pageUp) { setScroll((offset) => Math.min(offset + 8, maxScroll)); return; }
    if (key.pageDown) { setScroll((offset) => Math.max(0, offset - 8)); return; }
    if (key.return) {
      if (!input.trim()) return;
      onSubmit(input);
      setHistory((entries) => [...entries, input].slice(-100));
      setHistoryIndex(undefined); setInput(""); setPosition(0); setScroll(0); return;
    }
    if (key.upArrow || key.downArrow) {
      const index = Math.max(0, Math.min(history.length, (historyIndex ?? history.length) + (key.upArrow ? -1 : 1)));
      const next = history[index] ?? "";
      setHistoryIndex(index); setInput(next); setPosition(next.length); return;
    }
    if (key.leftArrow) { setPosition((index) => Math.max(0, index - 1)); return; }
    if (key.rightArrow) { setPosition((index) => Math.min(input.length, index + 1)); return; }
    if (key.ctrl && value === "a") { setPosition(0); return; }
    if (key.ctrl && value === "e") { setPosition(input.length); return; }
    if (key.ctrl && value === "u") { setInput(input.slice(position)); setPosition(0); return; }
    if (key.ctrl && value === "k") { setInput(input.slice(0, position)); return; }
    if (key.backspace || key.delete) {
      if (position > 0) { setInput(input.slice(0, position - 1) + input.slice(position)); setPosition(position - 1); }
      return;
    }
    if (!key.ctrl && !key.meta && value) {
      const next = clean(value);
      setInput(input.slice(0, position) + next + input.slice(position)); setPosition(position + next.length);
    }
  });
  const end = transcript.length - Math.min(scroll, maxScroll);
  const visible = transcript.slice(Math.max(0, end - 8), end);
  const panel = panelText(state);
  const waiting = Object.keys(state.pending).length;
  return <Box flexDirection="column">
    <Text bold color="cyan">Nyx <Text dimColor>{terminalField(state.session.session_id)}</Text></Text>
    <Text dimColor>{terminalField(state.selectedAgent)} · {terminalField(state.session.status)}{waiting ? ` · ${waiting} input${waiting === 1 ? "" : "s"} pending` : ""} · {budgetText(state.session)}{state.connection === "reconnecting" ? " · reconnecting" : ""}</Text>
    {state.verdict && <Box borderStyle="round" borderColor="green" paddingX={1} marginTop={1}>
      <Text bold color="green">Assessment verdict: </Text>
      <Text>{clean(String(state.verdict.payload.result ?? state.verdict.payload.verdict
        ?? state.verdict.payload.status ?? itemText(state.verdict)))}</Text>
    </Box>}
    <Box flexDirection="column" marginY={1}>
      {panel !== undefined ? <><Text bold>{state.panel}</Text><Text>{clean(panel)}</Text></>
        : visible.length ? visible.map((item) => <Box key={item.ref ?? item.sequence} flexDirection="column" marginBottom={1}>
          <Text color={item.kind === "user_message" ? "cyan" : item.kind === "question" ? "yellow" : undefined} bold>
            {item.kind === "user_message" ? "you" : terminalField(item.agent_path ?? "/root")}{item.kind === "question" ? ` · question ${terminalField(item.ref ?? item.sequence)}` : ""}
          </Text>
          <Text dimColor={item.kind.startsWith("tool_")}>{clean(itemText(item))}</Text>
        </Box>) : <Text dimColor>Ask a question, give the agent a task, or /help for commands.</Text>}
    </Box>
    {state.notice && <Text color={state.notice.error ? "red" : "yellow"}>{clean(state.notice.text)}</Text>}
    <Box borderStyle="round" borderColor="gray" paddingX={1}>
      <Text color="cyan">› </Text><Box flexGrow={1} flexShrink={1}>
        {/* Ink 5 must remeasure when editing inserts/removes text around the cursor span. */}
        <Text key={`${input}:${position}`}>{input.slice(0, position)}<Text inverse>{input[position] ?? " "}</Text>{input.slice(position + 1)}</Text>
      </Box>
    </Box>
    <Text dimColor>/help · /agents · /questions · PgUp/PgDn transcript · ↑/↓ input history · Esc transcript · Ctrl-C detach</Text>
  </Box>;
}

export function openSessionTui(initial: SessionViewState, callbacks: Omit<SessionScreenProps, "state">) {
  let listener: ((state: SessionViewState) => void) | undefined;
  let current = initial;
  function Screen() {
    const [state, setState] = useState(current);
    useEffect(() => { listener = setState; setState(current); return () => { listener = undefined; }; }, []);
    return <SessionScreen state={state} {...callbacks} />;
  }
  const instance = render(<Screen />, { exitOnCtrlC: false });
  return { update(state: SessionViewState) { current = state; listener?.(state); },
    close() { instance.unmount(); } };
}
