/**
 * Every way document intake can fail, and the exact user-facing string for each.
 *
 * One module owns the mapping so no route handler ever writes a message inline and drifts from
 * the catalogue. The strings are copied verbatim from docs/04-resilience.md §7 and asserted
 * against these constants in tests — a substring match would let a reworded message pass.
 *
 * Nothing here carries a stack, a status code, a vendor name, or an `error.message`
 * (AGENTS.md rule 4). The internal cause travels separately, to the log and `failureReason`.
 */

export type ParseFailureKind =
  | "too_large"
  | "unsupported_type"
  | "encrypted"
  | "scanned"
  | "corrupt"
  | "too_short";

/** A typed, non-throwing failure. Routes map `kind` to a response; users see `message`. */
export class ParseFailure {
  readonly kind: ParseFailureKind;
  readonly message: string;
  /** Internal detail for the log and `graphs.failureReason`. NEVER sent to the client. */
  readonly cause?: unknown;

  constructor(kind: ParseFailureKind, cause?: unknown) {
    this.kind = kind;
    this.message = PARSE_MESSAGES[kind];
    this.cause = cause;
  }
}

export const PARSE_MESSAGES: Record<ParseFailureKind, string> = {
  too_large:
    "That file is over the 10 MB limit. Try a smaller file, or paste the text directly.",
  unsupported_type: "Edgify reads PDF, DOCX, TXT and Markdown files.",
  encrypted:
    "That PDF is password-protected. Remove the protection, or paste the text.",
  scanned:
    "This looks like a scanned document — Edgify can't read the text yet. Paste the text directly and everything else will work.",
  corrupt:
    "That file couldn't be read. It may be damaged — try re-saving or exporting it again.",
  too_short: "There isn't enough text here to work with. Add a few paragraphs.",
};

export function isParseFailure(value: unknown): value is ParseFailure {
  return value instanceof ParseFailure;
}
