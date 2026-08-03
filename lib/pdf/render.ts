import type { jsPDF } from "jspdf";
import { parseBlocks, type Block, type Inline } from "./blocks";

/**
 * Block model → placed PDF (W7, docs/05). The second half of the export: `blocks.ts` decides WHAT
 * the content is, this decides WHERE it goes.
 *
 * The separation is the whole point. The previous renderer advanced a `y` cursor while walking
 * markdown lines, so page breaks were decided one line at a time with no knowledge of what came
 * next — which makes keep-with-next, orphan control and row-atomic tables not merely absent but
 * inexpressible. Here every block is measured before any of it is placed, so those rules are
 * ordinary conditions rather than impossibilities.
 *
 * Output stays VECTOR TEXT: selectable, searchable, and a few tens of KB. Rasterising through
 * `jsPDF.html()`/html2canvas would have cost all three.
 *
 * NO LINK ANNOTATIONS ARE EMITTED, deliberately — `blocks.ts` has already flattened `[text](url)`
 * to its label, so no model-controlled URL reaches this module. See the note there.
 */

/** 1 inch. */
const PT_PER_INCH = 72;

export const MARGIN = PT_PER_INCH;

type Style = {
  size: number;
  weight: "normal" | "bold";
  /** Multiplied by `size` to get the line box height. */
  lineHeight: number;
  /** Space before the block. Headings get MORE above than below, so they bind to what follows. */
  above: number;
  below: number;
};

/**
 * The type scale. Hierarchy comes from weight and SPACING as much as size — which is why every
 * heading's `above` is roughly double its `below`. A heading closer to the paragraph beneath it
 * than to the one above reads as part of that section; the reverse reads as a cramped list of
 * lines, which is what the old export looked like.
 */
export const STYLES = {
  title: { size: 24, weight: "bold", lineHeight: 1.2, above: 0, below: 18 },
  h1: { size: 20, weight: "bold", lineHeight: 1.25, above: 24, below: 10 },
  h2: { size: 16, weight: "bold", lineHeight: 1.3, above: 20, below: 8 },
  h3: { size: 13, weight: "bold", lineHeight: 1.35, above: 16, below: 6 },
  h4: { size: 11.5, weight: "bold", lineHeight: 1.4, above: 14, below: 5 },
  body: { size: 11, weight: "normal", lineHeight: 1.5, above: 0, below: 10 },
  quote: { size: 11, weight: "normal", lineHeight: 1.5, above: 10, below: 12 },
  code: { size: 9.5, weight: "normal", lineHeight: 1.4, above: 10, below: 12 },
  table: { size: 9.5, weight: "normal", lineHeight: 1.45, above: 12, below: 14 },
} as const satisfies Record<string, Style>;

/** Indent for list items and quotes. */
const INDENT = 18;
/** Cell padding inside table rows. */
const CELL_PAD = 6;
/**
 * A heading must be followed by this much content on the same page, or it moves to the next one.
 * Two body lines — enough that a heading is never the last thing on a page.
 */
const KEEP_WITH_NEXT = STYLES.body.size * STYLES.body.lineHeight * 2;
/** No paragraph leaves fewer than this many lines on either side of a page break. */
const MIN_LINES_EITHER_SIDE = 2;

/** A run measured at a given style, ready to place. */
type PlacedRun = Inline & { width: number };

function applyFont(doc: jsPDF, run: Inline, style: Style): void {
  if (run.code) {
    doc.setFont("courier", "normal");
  } else {
    const italic = run.italic === true;
    const bold = run.bold === true || style.weight === "bold";
    doc.setFont(
      "helvetica",
      bold && italic ? "bolditalic" : bold ? "bold" : italic ? "italic" : "normal",
    );
  }
  doc.setFontSize(style.size);
}

/**
 * Wrap styled runs into lines that fit `width`, measuring each word in ITS OWN font.
 *
 * `doc.splitTextToSize` cannot do this: it assumes one font for the whole string, so a line mixing
 * bold and regular would be measured wrongly and overflow the margin.
 */
export function wrapRuns(
  doc: jsPDF,
  runs: Inline[],
  style: Style,
  width: number,
): PlacedRun[][] {
  const lines: PlacedRun[][] = [[]];
  let used = 0;

  for (const run of runs) {
    applyFont(doc, run, style);
    // Keep the separators so spacing between words survives the split.
    for (const word of run.text.split(/(\s+)/)) {
      if (word === "") continue;
      const width_ = doc.getTextWidth(word);
      const isSpace = word.trim() === "";
      if (!isSpace && used + width_ > width && lines[lines.length - 1].length > 0) {
        lines.push([]);
        used = 0;
      }
      // A space that lands at the start of a wrapped line is dropped, not rendered.
      if (isSpace && lines[lines.length - 1].length === 0) continue;
      // `text: word` is load-bearing. Spreading `run` alone carries the WHOLE run's text into
      // every word-sized piece, so `drawLine` then paints the entire string at each successive x —
      // producing overlapping, repeated text. It rendered as garbage while every "contains"
      // assertion still passed, because the expected substrings were all present many times over.
      lines[lines.length - 1].push({ ...run, text: word, width: width_ });
      used += width_;
    }
  }

  return lines.filter((line) => line.length > 0);
}

/** The renderer's mutable cursor. */
type Cursor = { y: number; pageHeight: number; contentWidth: number };

function newPage(doc: jsPDF, cursor: Cursor): void {
  doc.addPage();
  cursor.y = MARGIN;
}

function fits(cursor: Cursor, height: number): boolean {
  return cursor.y + height <= cursor.pageHeight - MARGIN;
}

/** Two pieces can share one draw call when they render in the same font. */
function sameStyle(a: PlacedRun, b: PlacedRun): boolean {
  return (
    (a.bold ?? false) === (b.bold ?? false) &&
    (a.italic ?? false) === (b.italic ?? false) &&
    (a.code ?? false) === (b.code ?? false)
  );
}

/**
 * Place one already-wrapped line, LEFT-ALIGNED.
 *
 * Wrapping splits a line into word-sized pieces so each can be measured in its own font, but
 * DRAWING them one per word costs a text-showing operator each: the realistic study guide came
 * out at 82.5 KB against the old renderer's 10.8 KB, a 7.6× regression for output that reads the
 * same. Adjacent pieces sharing a font are merged back into a single `doc.text()` call, so an
 * ordinary all-regular line is one operator again and only genuinely mixed lines cost more.
 */
function drawLine(
  doc: jsPDF,
  line: PlacedRun[],
  style: Style,
  x: number,
  cursor: Cursor,
): void {
  let cursorX = x;
  let index = 0;
  while (index < line.length) {
    const first = line[index];
    let text = first.text;
    let width = first.width;
    let next = index + 1;
    while (next < line.length && sameStyle(first, line[next])) {
      text += line[next].text;
      width += line[next].width;
      next += 1;
    }
    applyFont(doc, first, style);
    // jsPDF places text on the BASELINE; 0.8 × size approximates the ascent, which keeps
    // successive line boxes evenly spaced.
    doc.text(text, cursorX, cursor.y + style.size * 0.8);
    cursorX += width;
    index = next;
  }
  cursor.y += style.size * style.lineHeight;
}

/**
 * Place a wrapped text block with orphan/widow control.
 *
 * If the block cannot be split leaving at least `MIN_LINES_EITHER_SIDE` on each page, the whole
 * block moves to the next page rather than stranding a single line.
 */
function drawWrapped(
  doc: jsPDF,
  lines: PlacedRun[][],
  style: Style,
  x: number,
  cursor: Cursor,
): void {
  const lineHeight = style.size * style.lineHeight;
  const roomNow = Math.max(0, Math.floor((cursor.pageHeight - MARGIN - cursor.y) / lineHeight));

  if (lines.length > 1 && roomNow < MIN_LINES_EITHER_SIDE) {
    newPage(doc, cursor);
  } else if (lines.length > 1 && lines.length - roomNow === 1 && roomNow > MIN_LINES_EITHER_SIDE) {
    // Exactly one line would be widowed onto the next page — carry one more down with it.
    const keepHere = roomNow - 1;
    for (let i = 0; i < keepHere; i++) drawLine(doc, lines[i], style, x, cursor);
    newPage(doc, cursor);
    for (let i = keepHere; i < lines.length; i++) drawLine(doc, lines[i], style, x, cursor);
    return;
  }

  for (const line of lines) {
    if (!fits(cursor, lineHeight)) newPage(doc, cursor);
    drawLine(doc, line, style, x, cursor);
  }
}

function drawTable(
  doc: jsPDF,
  block: Extract<Block, { kind: "table" }>,
  cursor: Cursor,
): void {
  const style = STYLES.table;
  const columns = block.header.length;
  if (columns === 0) return;

  // Column widths proportional to the widest cell in each column, normalised to the content width
  // so a table never runs past the margin.
  const natural = block.header.map((_, column) => {
    const cells = [block.header[column], ...block.rows.map((row) => row[column] ?? [])];
    return Math.max(
      ...cells.map((cell) => {
        let total = 0;
        for (const run of cell) {
          applyFont(doc, run, style);
          total += doc.getTextWidth(run.text);
        }
        return total;
      }),
      1,
    );
  });
  const totalNatural = natural.reduce((sum, width) => sum + width, 0);
  const widths = natural.map(
    (width) => (width / totalNatural) * (cursor.contentWidth - CELL_PAD * 2 * columns) + CELL_PAD * 2,
  );

  const rowHeight = style.size * style.lineHeight + CELL_PAD;
  cursor.y += style.above;

  const drawHeader = () => {
    doc.setFillColor(243, 244, 246);
    doc.rect(MARGIN, cursor.y, cursor.contentWidth, rowHeight, "F");
    let x = MARGIN;
    block.header.forEach((cell, column) => {
      let cellX = x + CELL_PAD;
      for (const run of cell) {
        applyFont(doc, { ...run, bold: true }, style);
        doc.text(run.text, cellX, cursor.y + rowHeight - CELL_PAD);
        cellX += doc.getTextWidth(run.text);
      }
      x += widths[column];
    });
    cursor.y += rowHeight;
  };

  if (!fits(cursor, rowHeight * 2)) newPage(doc, cursor);
  drawHeader();

  for (const row of block.rows) {
    // Rows are ATOMIC: a row never straddles a page, and the header repeats after a break.
    if (!fits(cursor, rowHeight)) {
      newPage(doc, cursor);
      drawHeader();
    }
    doc.setDrawColor(229, 231, 235);
    doc.line(MARGIN, cursor.y, MARGIN + cursor.contentWidth, cursor.y);
    let x = MARGIN;
    row.forEach((cell, column) => {
      let cellX = x + CELL_PAD;
      for (const run of cell) {
        applyFont(doc, run, style);
        doc.text(run.text, cellX, cursor.y + rowHeight - CELL_PAD);
        cellX += doc.getTextWidth(run.text);
      }
      x += widths[column] ?? 0;
    });
    cursor.y += rowHeight;
  }

  doc.setDrawColor(229, 231, 235);
  doc.line(MARGIN, cursor.y, MARGIN + cursor.contentWidth, cursor.y);
  cursor.y += style.below;
}

const HEADING_STYLE = [STYLES.h1, STYLES.h2, STYLES.h3, STYLES.h4] as const;

/** Render a parsed document into `doc`. Exported for tests that inspect placement. */
export function renderBlocks(doc: jsPDF, title: string, markdown: string): void {
  const pageWidth = doc.internal.pageSize.getWidth();
  const cursor: Cursor = {
    y: MARGIN,
    pageHeight: doc.internal.pageSize.getHeight(),
    contentWidth: pageWidth - MARGIN * 2,
  };

  // The title is passed separately by the caller and is not part of the markdown.
  const titleLines = wrapRuns(doc, [{ text: title }], STYLES.title, cursor.contentWidth);
  drawWrapped(doc, titleLines, STYLES.title, MARGIN, cursor);
  cursor.y += STYLES.title.below;

  for (const block of parseBlocks(markdown)) {
    switch (block.kind) {
      case "heading": {
        const style = HEADING_STYLE[block.level - 1];
        const lines = wrapRuns(doc, block.runs, style, cursor.contentWidth);
        const height = lines.length * style.size * style.lineHeight;
        cursor.y += style.above;
        // Keep-with-next: a heading never sits alone at the foot of a page.
        if (!fits(cursor, height + KEEP_WITH_NEXT)) newPage(doc, cursor);
        for (const line of lines) drawLine(doc, line, style, MARGIN, cursor);
        cursor.y += style.below;
        break;
      }
      case "paragraph": {
        const lines = wrapRuns(doc, block.runs, STYLES.body, cursor.contentWidth);
        drawWrapped(doc, lines, STYLES.body, MARGIN, cursor);
        cursor.y += STYLES.body.below;
        break;
      }
      case "list": {
        for (const [index, item] of block.items.entries()) {
          const lines = wrapRuns(doc, item, STYLES.body, cursor.contentWidth - INDENT);
          const lineHeight = STYLES.body.size * STYLES.body.lineHeight;
          if (!fits(cursor, lineHeight)) newPage(doc, cursor);
          applyFont(doc, { text: "" }, STYLES.body);
          doc.text(
            block.ordered ? `${index + 1}.` : "•",
            MARGIN,
            cursor.y + STYLES.body.size * 0.8,
          );
          for (const line of lines) {
            if (!fits(cursor, lineHeight)) newPage(doc, cursor);
            drawLine(doc, line, STYLES.body, MARGIN + INDENT, cursor);
          }
        }
        cursor.y += STYLES.body.below;
        break;
      }
      case "table":
        drawTable(doc, block, cursor);
        break;
      case "quote": {
        const style = STYLES.quote;
        const lines = wrapRuns(doc, block.runs, style, cursor.contentWidth - INDENT);
        cursor.y += style.above;
        const top = cursor.y;
        drawWrapped(doc, lines, style, MARGIN + INDENT, cursor);
        // A rule down the left edge, drawn after the text so its height is known.
        doc.setDrawColor(17, 17, 17);
        doc.setLineWidth(1.5);
        doc.line(MARGIN + 2, top, MARGIN + 2, cursor.y - 2);
        doc.setLineWidth(0.2);
        cursor.y += style.below;
        break;
      }
      case "code": {
        const style = STYLES.code;
        cursor.y += style.above;
        for (const raw of block.lines) {
          const lines = wrapRuns(doc, [{ text: raw, code: true }], style, cursor.contentWidth - INDENT);
          for (const line of lines) {
            if (!fits(cursor, style.size * style.lineHeight)) newPage(doc, cursor);
            drawLine(doc, line, style, MARGIN + INDENT, cursor);
          }
        }
        cursor.y += style.below;
        break;
      }
      case "rule": {
        if (!fits(cursor, 20)) newPage(doc, cursor);
        cursor.y += 8;
        doc.setDrawColor(229, 231, 235);
        doc.line(MARGIN, cursor.y, MARGIN + cursor.contentWidth, cursor.y);
        cursor.y += 12;
        break;
      }
    }
  }
}
