import { apiRawRequest } from "./client.js";
import type { SSEEvent, SSEEventType } from "./types.js";
import { NyxError } from "../utils/errors.js";

export interface StreamCallbacks {
  onEvent(event: SSEEvent): void;
  onDone(): void;
}

export interface StreamResult {
  reportUrl?: string;
}

const TERMINAL_EVENTS: SSEEventType[] = [
  "run.completed",
  "run.failed",
  "run.error",
];

export async function connectStream(
  streamPath: string,
  callbacks: StreamCallbacks
): Promise<StreamResult> {
  const res = await apiRawRequest("GET", streamPath, "text/event-stream");

  if (!res.body) {
    throw new NyxError("No response body for stream", "api");
  }

  let reportUrl: string | undefined;
  const abortController = new AbortController();

  const abortHandler = () => {
    abortController.abort();
    callbacks.onDone();
    console.log("\n  Interrupted. Run continues server-side.");
    console.log("  Check status with: nyx status <name>\n");
    process.exit(0);
  };
  process.on("SIGINT", abortHandler);

  try {
    let buffer = "";
    for await (const chunk of readStream(res.body, abortController.signal)) {
      buffer += chunk;

      const parts = buffer.split("\n\n");
      buffer = parts.pop()!;

      for (const part of parts) {
        const event = parseSSE(part);
        if (!event) continue;

        callbacks.onEvent(event);

        if (event.event === "run.completed" && event.data.report_url) {
          reportUrl = event.data.report_url as string;
        }

        if (TERMINAL_EVENTS.includes(event.event)) {
          callbacks.onDone();
          return { reportUrl };
        }
      }
    }
  } finally {
    process.off("SIGINT", abortHandler);
  }

  return { reportUrl };
}

async function* readStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
  } finally {
    reader.cancel();
  }
}

function parseSSE(raw: string): SSEEvent | null {
  let event = "";
  const dataLines: string[] = [];
  let id: string | undefined;

  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    else if (line.startsWith("id:")) id = line.slice(3).trim();
  }

  const data = dataLines.join("\n");
  if (!event || !data) return null;

  try {
    return { event: event as SSEEventType, data: JSON.parse(data), id };
  } catch {
    return null;
  }
}
