import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Phase 4 acceptance: every Quick Notes format produces sensible output.
 *
 * Runs each format once against the live model and checks the SHAPE of what comes back, not its
 * wording — a model's prose cannot be asserted, but "did the summary come back as bullet points"
 * and "did the quiz come back gradeable" can be, and those are the failures that actually occur.
 *
 * Note the count: the prototype defines EIGHT formats (docs/reference/trellis-prototype.html
 * FORMATS). docs/06 Phase 4 says "all nine formats"; there is no ninth, and none was invented.
 *
 * Usage: SESSION_COOKIE=<name=value> node --env-file=.env.local test/e2e/all-formats.mjs
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const BASE = process.env.APP_BASE ?? "http://localhost:3000";
const SAMPLE = readFileSync(join(repoRoot, "test/e2e/sample-text.txt"), "utf8").trim();

const cookie = process.env.SESSION_COOKIE;
if (!cookie) throw new Error("SESSION_COOKIE is not set");

/** id → what "sensible" means for that format, beyond being non-empty. */
const EXPECTATIONS = {
  key_points: { mode: "md", check: (t) => /^\s*[-*]\s+/m.test(t), why: "a bulleted list" },
  main_concepts: { mode: "md", check: (t) => /\*\*/.test(t), why: "bold concept names" },
  exam_points: { mode: "md", check: (t) => /likely questions/i.test(t), why: "a 'Likely questions' section" },
  short_notes: { mode: "md", check: (t) => t.length > 80, why: "condensed notes" },
  formulas_terms: { mode: "md", check: (t) => /\*\*/.test(t), why: "bold terms" },
  summary: { mode: "md", check: (t) => !/^\s*[-*]\s+/m.test(t), why: "prose, explicitly NOT bullets" },
  mcqs: { mode: "quiz", count: 5 },
  quick_test: { mode: "quiz", count: 4 },
};

function gradeable(quiz) {
  if (!quiz || !Array.isArray(quiz.questions) || quiz.questions.length === 0) return false;
  return quiz.questions.every(
    (q) =>
      typeof q.q === "string" &&
      q.q.length > 0 &&
      Array.isArray(q.options) &&
      q.options.length >= 2 &&
      Number.isInteger(q.answer) &&
      q.answer >= 0 &&
      q.answer < q.options.length,
  );
}

async function run(format) {
  const text = `${SAMPLE}\n\nFormat probe ${format} ${Date.now()}.`;
  const res = await fetch(`${BASE}/api/notes/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ text, format }),
  });

  const kind = res.headers.get("X-Trellis-Kind");
  if (kind === "stream") {
    return { kind, tier: res.headers.get("X-Trellis-Tier"), text: await res.text() };
  }
  const body = await res.json().catch(() => ({}));
  return { kind, tier: body.tier, notice: body.notice, data: body.data, message: body.message };
}

let passed = 0;
const rows = [];

for (const [format, spec] of Object.entries(EXPECTATIONS)) {
  const r = await run(format);
  let ok = false;
  let detail = "";

  if (r.kind === "busy" || r.kind === "message") {
    detail = `no result (${r.kind})`;
  } else if (spec.mode === "quiz") {
    const quiz = r.data;
    ok = gradeable(quiz);
    const n = quiz?.questions?.length ?? 0;
    detail = ok
      ? `${n} gradeable questions${n === spec.count ? "" : ` (asked for ${spec.count})`}`
      : "not gradeable";
  } else {
    const text = r.kind === "stream" ? r.text : typeof r.data === "string" ? r.data : "";
    const nonEmpty = text.trim().length > 40;
    ok = nonEmpty && spec.check(text);
    detail = ok
      ? `${text.length} chars, ${spec.why}`
      : nonEmpty
        ? `${text.length} chars but missing ${spec.why}`
        : "empty or near-empty";
  }

  if (r.notice) detail += `  [${r.notice} fallback]`;
  if (ok) passed++;
  rows.push({ format, ok, tier: r.tier ?? "-", detail });
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${format.padEnd(15)} tier=${(r.tier ?? "-").padEnd(6)} ${detail}`,
  );
}

console.log(`\n${passed}/${rows.length} formats produced sensible output`);
if (passed !== rows.length) process.exit(1);
