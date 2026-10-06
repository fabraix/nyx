import { setTimeout as delay } from "node:timers/promises";
import { getSession, listItems, retryableTransportError } from "./session.js";
import type { ItemPage, Session } from "./session.js";
import type { SessionEvent } from "../ui/session-state.js";
import { NyxError } from "../utils/errors.js";

interface EventSource {
  getSession: (sessionId: string, signal?: AbortSignal) => Promise<Session>;
  listItems: (sessionId: string, after: number, signal?: AbortSignal) => Promise<ItemPage>;
}

/** Feed the TUI from durable session events. Reads are safe to retry. */
export async function* sessionEvents(sessionId: string, options: {
  after: number; signal: AbortSignal; pollMs?: number;
  source?: EventSource;
}): AsyncGenerator<SessionEvent> {
  const source: EventSource = options.source ?? { getSession, listItems };
  let after = options.after;
  let failures = 0;
  while (!options.signal.aborted) {
    try {
      const session = await source.getSession(sessionId, options.signal);
      if (failures) { failures = 0; yield { type: "connection", status: "connected" }; }
      yield { type: "session", session };
      let advanced: boolean;
      do {
        const page = await source.listItems(sessionId, after, options.signal);
        const previous = after;
        for (const item of page.items) {
          if (!Number.isSafeInteger(item.sequence) || item.sequence <= after) {
            throw new NyxError("Server returned an invalid session cursor.", "api");
          }
          yield { type: "item", item };
          after = item.sequence;
        }
        if (!Number.isSafeInteger(page.next_sequence) || page.next_sequence < after) {
          throw new NyxError("Server returned an invalid session cursor.", "api");
        }
        after = page.next_sequence;
        advanced = after > previous;
      } while (advanced && !options.signal.aborted);
      // Marks a fully drained poll, including pages that carried no items.
      yield { type: "cursor", sequence: after };
    } catch (error) {
      if (options.signal.aborted) return;
      if (!retryableTransportError(error)) throw error;
      failures += 1;
      yield { type: "connection", status: "reconnecting", message: "Connection lost; retrying from the durable cursor…" };
    }
    try {
      await delay(failures ? Math.min(500 * 2 ** Math.min(failures - 1, 5), 10_000) : (options.pollMs ?? 500),
        undefined, { signal: options.signal });
    } catch (error) { if (!options.signal.aborted) throw error; }
  }
}
