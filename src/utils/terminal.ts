import { stripVTControlCharacters } from "node:util";

/** Untrusted text is data, never terminal instructions. Preserve ordinary prose. */
export function terminalText(value: unknown): string {
  return stripVTControlCharacters(String(value ?? ""))
    // Also remove invisible bidi steering. LRM/RLM and ALM can reorder an
    // otherwise ordinary-looking status line without being an ANSI escape;
    // the explicit embedding/override/isolate controls are equally unsafe at
    // every terminal output boundary.
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/g, "");
}

/** Labels cannot introduce a second status/header line. */
export function terminalField(value: unknown): string {
  return terminalText(value).replace(/[\n\t]/g, " ");
}
