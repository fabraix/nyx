import { maintainRequestOutbox } from "../api/request-outbox.js";
import { createSession, resolveOutboxReceipt } from "../api/session.js";
import type { Session } from "../api/session.js";
import { sessionEvents } from "../api/session-events.js";
import { createSessionController } from "../ui/session-controller.js";
import { initialSessionState, reduceSession } from "../ui/session-state.js";
import type { SessionEvent } from "../ui/session-state.js";
import { openSessionTui } from "../ui/session-tui.js";
import { handleError, NyxError } from "../utils/errors.js";

/** Serialized terminal commands with a drain point that always settles on detach. */
export function createCommandQueue(options: {
  signal: AbortSignal;
  execute: (line: string) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  let tail = Promise.resolve();
  return {
    submit(line: string): void {
      tail = tail.then(async () => {
        if (options.signal.aborted) return;
        try {
          await options.execute(line);
        } catch (error) {
          if (!options.signal.aborted) options.onError(error);
        }
      });
    },
    drain(): Promise<void> { return tail; },
  };
}

export async function startTui(): Promise<void> {
  const abort = new AbortController();
  let outboxMaintenance: ReturnType<typeof maintainRequestOutbox> | undefined;
  const detach = (): void => { abort.abort(); };
  process.on("SIGINT", detach);
  process.on("SIGTERM", detach);
  try {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new NyxError("Nyx requires an interactive terminal. Run `nyx` in your terminal, then enter your request.", "config");
    }
    // This best-effort task is attached to the TUI lifecycle. It never replays
    // an uncertain write: authenticated receipt state is the only authority
    // that can retire an attempted journal.
    outboxMaintenance = maintainRequestOutbox({
      signal: abort.signal,
      resolveReceipt: resolveOutboxReceipt,
    });
    const session = await createSession({ signal: abort.signal });
    if (!abort.signal.aborted) await interact(session, abort);
  } catch (error) {
    if (abort.signal.aborted) return;
    handleError(error);
  } finally {
    abort.abort();
    if (outboxMaintenance) await Promise.allSettled([outboxMaintenance]);
    process.off("SIGINT", detach);
    process.off("SIGTERM", detach);
  }
}

async function interact(session: Session, abort: AbortController): Promise<void> {
  if (!session.session_id) throw new NyxError("Server returned a session without an ID.", "api");
  let state = initialSessionState(session);
  const detach = (): void => { abort.abort(); };
  let tui: ReturnType<typeof openSessionTui> | undefined;
  const dispatch = (event: SessionEvent): void => {
    state = reduceSession(state, event);
    tui?.update(state);
  };
  const controller = createSessionController({ state: () => state, dispatch, detach, signal: abort.signal });
  const commands = createCommandQueue({
    signal: abort.signal,
    execute: controller.command,
    onError: (error) => dispatch({
      type: "notice",
      text: error instanceof Error ? error.message : String(error),
      error: true,
    }),
  });

  try {
    tui = openSessionTui(state, {
      onSubmit: commands.submit,
      onDetach: detach,
      onClosePanel: () => dispatch({ type: "panel", panel: "transcript" }),
    });
    for await (const event of sessionEvents(session.session_id, { after: 0, signal: abort.signal })) {
      dispatch(event);
      if (abort.signal.aborted) break;
    }
  } finally {
    abort.abort();
    await Promise.allSettled([commands.drain(), controller.drain()]);
    tui?.close();
  }
}
