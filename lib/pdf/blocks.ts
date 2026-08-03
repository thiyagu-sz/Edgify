/**
 * Markdown → a typed BLOCK MODEL, for the PDF renderer (W7, docs/05).
 *
 * The export used to walk markdown line by line, calling `doc.text()` at manually-advanced
 * coordinates. That is why its output read as raw text dumped onto a page: a renderer that sees a
 * line at a time has no way to express "keep this heading with its paragraph", "never split this
 * table row", or "this bold run sits inside that sentence" — those are properties of BLOCKS, and
 * there were no blocks. Measured defects on a realistic study guide before this change: tables
 * printed as literal `|` pipes, `####` headings kept their hashes, code fences printed verbatim,
 * `[text](url)` printed raw, and a global `_` strip silently corrupted `renal_artery_stenosis`
 * into `renalarterystenosis`.
 *
 * So parsing is separated from placement. This module is pure — no jsPDF, no DOM, no I/O — which
 * makes every classification decision testable without rendering anything.
 *
 * ── LINKS ARE DELIBERATELY FLATTENED TO THEIR TEXT ──────────────────────────────────────────
 *
 * `[text](url)` becomes `text`, and NO link annotation is emitted downstream. A clickable PDF
 * annotation built from model output would be a new execution surface that PROOF 5 has never
 * covered, and exported content is DISTRIBUTED: the generation cache is content-addressed, so one
 * poisoned document's notes reach every user who uploads the same file. An inert export cannot
 * carry that. Restoring real links is a future decision needing its own verification and an
 * http/https/mailto allowlist — not a default.
 */

/** A styled span within a line of text. */
export type Inline = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
};

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3 | 4; runs: Inline[] }
  | { kind: "paragraph"; runs: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "table"; header: Inline[][]; rows: Inline[][][] }
  | { kind: "quote"; runs: Inline[] }
  | { kind: "code"; lines: string[] }
  | { kind: "rule" };

const FENCE = /^\s*```/;
const HEADING = /^(#{1,4})\s+(.*)$/;
const RULE = /^\s*([-*_])\1{2,}\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const UNORDERED = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
/** `|---|:--:|` — the row that turns the line above it into a table header. */
const TABLE_DIVIDER = /^\s*\|[\s:|-]+\|\s*$/;

/**
 * Split a line into styled runs.
 *
 * Order matters and is not arbitrary: code spans are taken FIRST so `**` inside `` `a ** b` ``
 * stays literal, then links are flattened, then bold before italic so `**x**` is not read as two
 * italic markers.
 */
export function parseInline(text: string): Inline[] {
  const runs: Inline[] = [];

  const emit = (raw: string, style: Omit<Inline, "text">) => {
    if (raw.length > 0) runs.push({ text: raw, ...style });
  };

  // `code` — highest precedence, contents are never re-parsed.
  const CODE = /`([^`]+)`/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = CODE.exec(text)) !== null) {
    if (match.index > cursor) pushStyled(text.slice(cursor, match.index), runs);
    emit(match[1], { code: true });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) pushStyled(text.slice(cursor), runs);

  return runs.length > 0 ? runs : [{ text: "" }];
}

/** Bold / italic / links, for a stretch already known to contain no code spans. */
function pushStyled(text: string, runs: Inline[]): void {
  /**
   * `[label](target)` → `label`. The target is DROPPED, not rendered: see the module note.
   *
   * The target pattern tolerates ONE level of nested parentheses. A naive `\([^)]*\)` stops at the
   * first `)`, so `[click me](javascript:alert(1))` left a stray `)` in the output — caught by the
   * test, not by reading. Targets legitimately contain parens too (Wikipedia URLs are the usual
   * example), so this is not only about the malicious shape.
   */
  const flattened = text.replace(/\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1");

  // **bold** first, then *italic* / _italic_.
  const TOKEN =
    /(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|((?<![A-Za-z0-9_])_[^_\n]+_(?![A-Za-z0-9_]))/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = TOKEN.exec(flattened)) !== null) {
    if (match.index > cursor) {
      runs.push({ text: flattened.slice(cursor, match.index) });
    }
    const token = match[0];
    if (token.startsWith("**")) {
      runs.push({ text: token.slice(2, -2), bold: true });
    } else {
      runs.push({ text: token.slice(1, -1), italic: true });
    }
    cursor = match.index + token.length;
  }
  if (cursor < flattened.length) {
    runs.push({ text: flattened.slice(cursor) });
  }
}

/** Split `| a | b |` into its cells, dropping the outer pipes. */
function tableCells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((cell) => cell.trim());
}

/**
 * Parse a markdown document into blocks.
 *
 * Consecutive plain lines join into ONE paragraph rather than becoming a block each — that is what
 * lets the renderer wrap and keep a paragraph together, and it is precisely what the line-by-line
 * renderer could not represent.
 */
export function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  const flushParagraph = (buffer: string[]) => {
    if (buffer.length > 0) {
      blocks.push({ kind: "paragraph", runs: parseInline(buffer.join(" ").trim()) });
      buffer.length = 0;
    }
  };

  const paragraph: string[] = [];

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code — taken verbatim, never inline-parsed.
    if (FENCE.test(line)) {
      flushParagraph(paragraph);
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence (or end of input)
      blocks.push({ kind: "code", lines: body });
      continue;
    }

    if (line.trim() === "") {
      flushParagraph(paragraph);
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      flushParagraph(paragraph);
      blocks.push({ kind: "rule" });
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph(paragraph);
      blocks.push({
        kind: "heading",
        level: heading[1].length as 1 | 2 | 3 | 4,
        runs: parseInline(heading[2].trim()),
      });
      i += 1;
      continue;
    }

    // Table: a pipe row FOLLOWED BY a divider row. Without the divider it is just text that
    // happens to contain pipes, and treating it as a table would mangle it.
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
      flushParagraph(paragraph);
      const header = tableCells(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i])) {
        rows.push(tableCells(lines[i]).map(parseInline));
        i += 1;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      flushParagraph(paragraph);
      const body: string[] = [quote[1]];
      i += 1;
      while (i < lines.length && QUOTE.test(lines[i])) {
        body.push((QUOTE.exec(lines[i]) as RegExpExecArray)[1]);
        i += 1;
      }
      blocks.push({ kind: "quote", runs: parseInline(body.join(" ").trim()) });
      continue;
    }

    const unordered = UNORDERED.exec(line);
    const ordered = ORDERED.exec(line);
    if (unordered || ordered) {
      flushParagraph(paragraph);
      const isOrdered = ordered !== null && unordered === null;
      const items: Inline[][] = [];
      while (i < lines.length) {
        const u = UNORDERED.exec(lines[i]);
        const o = ORDERED.exec(lines[i]);
        const matched = isOrdered ? o : u;
        // A different marker starts a NEW list rather than continuing this one.
        if (!matched || (isOrdered ? u !== null && o === null : o !== null && u === null)) break;
        items.push(parseInline(matched[1].trim()));
        i += 1;
      }
      blocks.push({ kind: "list", ordered: isOrdered, items });
      continue;
    }

    paragraph.push(line.trim());
    i += 1;
  }

  flushParagraph(paragraph);
  return blocks;
}

/** Flatten a run list back to plain text — used by tests and by width measurement. */
export function runsToText(runs: Inline[]): string {
  return runs.map((run) => run.text).join("");
}
