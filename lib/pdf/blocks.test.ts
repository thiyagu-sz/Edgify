import { describe, expect, it } from "vitest";
import { graphToMarkdown } from "../graph/study-guide";
import { parseBlocks, parseInline, runsToText, type Block, type Inline } from "./blocks";

/** Type-safe accessors — a cast would hide a block landing in the wrong branch. */
function runsOf(block: Block): Inline[] {
  if ("runs" in block) return block.runs;
  throw new Error(`expected a block with runs, got "${block.kind}"`);
}
function itemsOf(block: Block): Inline[][] {
  if (block.kind === "list") return block.items;
  throw new Error(`expected a list, got "${block.kind}"`);
}
function tableOf(block: Block): Extract<Block, { kind: "table" }> {
  if (block.kind === "table") return block;
  throw new Error(`expected a table, got "${block.kind}"`);
}

/**
 * The block parser (W7). Pure — no jsPDF, no DOM — so every classification decision is checked
 * here rather than inferred from a rendered PDF.
 *
 * Each case below corresponds to a defect MEASURED on the old line-by-line renderer, listed in
 * the module header of blocks.ts. They are written as "the block model represents this correctly",
 * because that representation is exactly what the old renderer lacked.
 */

const kinds = (blocks: Block[]) => blocks.map((b) => b.kind);

describe("headings", () => {
  it("classifies all four levels, including the h4 that used to keep its hashes", () => {
    const blocks = parseBlocks("# One\n\n## Two\n\n### Three\n\n#### Four");
    expect(kinds(blocks)).toEqual(["heading", "heading", "heading", "heading"]);
    expect(blocks.map((b) => (b.kind === "heading" ? b.level : 0))).toEqual([1, 2, 3, 4]);
    // The old renderer only matched `### `, `## ` and `# `, so `#### Clinical note` fell through
    // to body text WITH its hashes visible.
    expect(runsToText(runsOf(blocks[3]))).toBe("Four");
  });

  it("keeps heading text free of the marker", () => {
    const [block] = parseBlocks("## Renin-Angiotensin-Aldosterone System  (Advanced)");
    expect(runsToText(runsOf(block))).toBe(
      "Renin-Angiotensin-Aldosterone System  (Advanced)",
    );
  });
});

describe("paragraphs", () => {
  it("joins consecutive lines into ONE paragraph", () => {
    // The property the line-by-line renderer could not express: a paragraph is a unit, so it can
    // be wrapped and kept together.
    const blocks = parseBlocks("First line\nsecond line\nthird line");
    expect(blocks).toHaveLength(1);
    expect(runsToText(runsOf(blocks[0]))).toBe(
      "First line second line third line",
    );
  });

  it("splits paragraphs on a blank line", () => {
    expect(kinds(parseBlocks("One\n\nTwo"))).toEqual(["paragraph", "paragraph"]);
  });
});

describe("inline runs", () => {
  it("marks bold without leaking the asterisks", () => {
    const runs = parseInline("**Prerequisites:** Blood Vessel Structure");
    expect(runs[0]).toEqual({ text: "Prerequisites:", bold: true });
    expect(runsToText(runs)).toBe("Prerequisites: Blood Vessel Structure");
    expect(runsToText(runs)).not.toContain("*");
  });

  it("marks italic for *Example:* as graphToMarkdown emits it", () => {
    const runs = parseInline("*Example:* Rolling a ball into a bowl.");
    expect(runs[0]).toEqual({ text: "Example:", italic: true });
  });

  it("marks code spans and does not re-parse their contents", () => {
    const runs = parseInline("Pressure is `MAP = CO ** TPR` in the model");
    const code = runs.find((r) => r.code);
    expect(code?.text).toBe("MAP = CO ** TPR");
    // The `**` inside the code span must NOT have become bold.
    expect(runs.some((r) => r.bold)).toBe(false);
  });

  it("PRESERVES snake_case — the old renderer stripped every underscore", () => {
    // `.replace(/_/g,"")` turned `renal_artery_stenosis` into `renalarterystenosis`: silent
    // corruption of the user's own material, worst in code and medical identifiers.
    const runs = parseInline("the variable renal_artery_stenosis is intact");
    expect(runsToText(runs)).toContain("renal_artery_stenosis");
    expect(runs.some((r) => r.italic)).toBe(false);
  });

  it("still treats _italic_ as italic when the underscores delimit a word", () => {
    const runs = parseInline("this is _emphasised_ text");
    expect(runs.find((r) => r.italic)?.text).toBe("emphasised");
  });
});

describe("links are flattened to their text, with no target", () => {
  /**
   * The decision recorded in blocks.ts: a clickable annotation built from model output is a new
   * execution surface PROOF 5 does not cover, and exports are distributed through the
   * content-addressed cache. So the label survives and the target does not reach the renderer.
   */
  it("keeps the label and drops the URL", () => {
    const runs = parseInline("See [the reference](https://example.com/raas) for details.");
    const text = runsToText(runs);
    expect(text).toBe("See the reference for details.");
    expect(text).not.toContain("https://");
    expect(text).not.toContain("[");
    expect(text).not.toContain("](");
  });

  it("drops a javascript: target entirely rather than rendering it as text", () => {
    const text = runsToText(parseInline("[click me](javascript:alert(1))"));
    expect(text).toBe("click me");
    expect(text).not.toContain("javascript:");
  });

  it("drops a data: target too", () => {
    const text = runsToText(parseInline("[doc](data:text/html;base64,PHNjcmlwdD4=)"));
    expect(text).toBe("doc");
    expect(text).not.toContain("data:");
  });
});

describe("lists", () => {
  it("groups consecutive bullets into one list block", () => {
    const blocks = parseBlocks("- one\n- two\n- three");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("list");
    expect(itemsOf(blocks[0])).toHaveLength(3);
    expect((blocks[0] as Extract<Block, { kind: "list" }>).ordered).toBe(false);
  });

  it("recognises an ordered list and keeps it separate from a bulleted one", () => {
    const blocks = parseBlocks("1. first\n2. second\n\n- bullet");
    expect(kinds(blocks)).toEqual(["list", "list"]);
    expect((blocks[0] as Extract<Block, { kind: "list" }>).ordered).toBe(true);
    expect((blocks[1] as Extract<Block, { kind: "list" }>).ordered).toBe(false);
  });

  it("strips the marker from the item text", () => {
    const blocks = parseBlocks("- Point one about resistance");
    expect(runsToText(itemsOf(blocks[0])[0])).toBe("Point one about resistance");
  });
});

describe("tables", () => {
  const md = [
    "| Drug class | Target | Effect |",
    "|---|---|---|",
    "| ACE inhibitor | ACE | Blocks synthesis |",
    "| ARB | AT1 receptor | Blocks action |",
  ].join("\n");

  it("becomes a table block, not literal pipes", () => {
    const blocks = parseBlocks(md);
    expect(kinds(blocks)).toEqual(["table"]);
    const table = tableOf(blocks[0]);
    expect(table.header.map((c) => runsToText(c))).toEqual([
      "Drug class",
      "Target",
      "Effect",
    ]);
    expect(table.rows).toHaveLength(2);
    expect(runsToText(table.rows[0][0])).toBe("ACE inhibitor");
  });

  it("does NOT swallow the divider row as content", () => {
    // The old renderer printed `|---|---|` as a line of body text.
    const blocks = parseBlocks(md);
    const flat = JSON.stringify(blocks);
    expect(flat).not.toContain("---");
  });

  it("treats a pipe line WITHOUT a divider as an ordinary paragraph", () => {
    // Otherwise prose containing a pipe would be mangled into a one-row table.
    const blocks = parseBlocks("a | b is a choice, not a table");
    expect(kinds(blocks)).toEqual(["paragraph"]);
  });
});

describe("code blocks and rules", () => {
  it("captures a fenced block verbatim without the fences", () => {
    const blocks = parseBlocks("before\n\n```\nMAP = CO * TPR\n```\n\nafter");
    expect(kinds(blocks)).toEqual(["paragraph", "code", "paragraph"]);
    expect((blocks[1] as Extract<Block, { kind: "code" }>).lines).toEqual(["MAP = CO * TPR"]);
    expect(JSON.stringify(blocks)).not.toContain("```");
  });

  it("recognises a horizontal rule", () => {
    expect(kinds(parseBlocks("a\n\n---\n\nb"))).toEqual(["paragraph", "rule", "paragraph"]);
  });

  it("recognises a block quote", () => {
    const blocks = parseBlocks("> quoted line\n> continues here");
    expect(kinds(blocks)).toEqual(["quote"]);
    expect(runsToText(runsOf(blocks[0]))).toBe(
      "quoted line continues here",
    );
  });
});

describe("the real study guide parses into the shape the renderer expects", () => {
  it("produces headings, paragraphs and a study-order list — no stray markers", () => {
    const md = graphToMarkdown(
      "Pathophysiology of Hypertension",
      [
        { slug: "raas", name: "RAAS", difficulty: "Advanced", summary: "Renin cascade.", estimatedMinutes: 180 },
        { slug: "vessels", name: "Blood Vessel Structure", difficulty: "Foundational", summary: "Three layers.", estimatedMinutes: 120 },
      ],
      [{ prerequisite: "vessels", dependent: "raas" }],
      new Map(),
    );
    const blocks = parseBlocks(md);

    expect(blocks.some((b) => b.kind === "heading")).toBe(true);
    expect(blocks.some((b) => b.kind === "list")).toBe(true);
    // No marker characters survive into rendered text anywhere.
    const text = blocks
      .flatMap((b) => ("runs" in b ? [runsToText(b.runs)] : []))
      .join(" ");
    expect(text).not.toMatch(/\*\*/);
    expect(text).not.toMatch(/^#/m);
  });
});
