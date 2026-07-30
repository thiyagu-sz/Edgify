import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Does parsing many PDFs in sequence return memory to baseline?
 *
 * docs/04 §4 requires the parsed document to be released in a `finally`, warning that skipping it
 * "quietly exhausts container memory after enough uploads". The failure mode is a container that
 * dies after a few dozen uploads, so proving ONE parse works proves nothing — this parses N in a
 * row and watches the trend.
 *
 * Three arms, in three independent child processes:
 *
 *   fixed     the real `extractPdf`, which releases in a `finally`. Must plateau.
 *   nodestroy the same work with the release removed. REPORTED AS A MEASUREMENT, not asserted —
 *             see the finding below.
 *   retain    deliberately keeps every document alive in an array. Must grow clearly; this is
 *             the arm that proves the harness can SEE a leak at all.
 *
 * Why a synthetic `retain` arm rather than using `nodestroy` as the control: on unpdf 1.8 under
 * Node's fake worker, skipping the release does NOT produce unbounded growth. The proxy becomes
 * unreachable when the iteration ends and V8 collects it; measured RSS plateaus (156.4 MB after
 * 60 un-released parses, 157.5 MB after 60 more). So `nodestroy` cannot serve as a control — a
 * harness asserting "removing the fix must break it" would fail forever against correct code.
 * `retain` is a leak that genuinely exists, so it establishes that a plateau in the `fixed` arm
 * is a real result rather than an instrument that measures nothing.
 *
 * None of that is an argument for dropping the `finally`. It releases eagerly instead of waiting
 * for a collection that may not come under memory pressure, it costs nothing, and it is what the
 * spec requires. `lib/parse/pdf.test.ts` is the deterministic gate that it is always called.
 *
 * Not part of `npm test`: needs `--expose-gc`, takes minutes, and GC timing is too
 * nondeterministic to gate CI on.
 *
 *   node test/e2e/parse-memory.mjs          # all three arms
 *   N=400 node test/e2e/parse-memory.mjs    # longer run
 */

const SELF = fileURLToPath(import.meta.url);
const N = Number(process.env.N ?? 200);
const WARMUP = Number(process.env.WARMUP ?? 20);
const SAMPLE_EVERY = Number(process.env.SAMPLE_EVERY ?? 10);
const PAGES = Number(process.env.PAGES ?? 20);
const MB = 1024 * 1024;

// ── child: run one arm and report samples ───────────────────────────────────
if (process.env.MODE) {
  const mode = process.env.MODE;
  const { extractPdf } = await import("../../lib/parse/pdf.ts");
  const { getDocumentProxy, extractText } = await import("unpdf");
  const { textPdf } = await import("../fixtures/pdf.ts");

  /**
   * One fixture, copied per iteration. The copy is not optional: pdf.js DETACHES the array it is
   * given, so reusing it fails on the second parse (see lib/parse/pdf.ts). It also models
   * reality — every real upload arrives as its own buffer.
   */
  const template = textPdf(PAGES);
  const freshBytes = () => Uint8Array.from(template);

  /** Holds documents alive — the synthetic leak the harness must be able to detect. */
  const retained = [];

  async function parseWithoutRelease(bytes) {
    const doc = await getDocumentProxy(bytes);
    const { totalPages, text } = await extractText(doc, { mergePages: true });
    return { text: text.trim(), pageCount: totalPages };
  }

  async function parseAndRetain(bytes) {
    const doc = await getDocumentProxy(bytes);
    const { totalPages, text } = await extractText(doc, { mergePages: true });
    retained.push(doc);
    return { text: text.trim(), pageCount: totalPages };
  }

  const parse =
    mode === "retain"
      ? parseAndRetain
      : mode === "nodestroy"
        ? parseWithoutRelease
        : extractPdf;

  const settle = async () => {
    // Twice: the first pass queues finalizers, the second collects what they released.
    global.gc();
    await new Promise((r) => setTimeout(r, 60));
    global.gc();
  };

  const samples = [];
  for (let i = 1; i <= N; i++) {
    const result = await parse(freshBytes());
    if (!result || typeof result.pageCount !== "number") {
      console.error(JSON.stringify({ error: `iteration ${i} did not parse`, mode, result }));
      process.exit(2);
    }
    if (i > WARMUP && i % SAMPLE_EVERY === 0) {
      await settle();
      const m = process.memoryUsage();
      samples.push({ i, heapUsed: m.heapUsed, rss: m.rss, external: m.external });
    }
  }

  process.stdout.write(JSON.stringify({ mode, n: N, retained: retained.length, samples }));
  process.exit(0);
}

// ── parent: run every arm and compare ───────────────────────────────────────
function runArm(mode) {
  const res = spawnSync(process.execPath, ["--expose-gc", "--import", "tsx", SELF], {
    env: { ...process.env, MODE: mode, N: String(N), PAGES: String(PAGES) },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) {
    console.error(`\n  ${mode} arm failed:\n${res.stderr?.slice(-2000) ?? ""}`);
    process.exit(1);
  }
  return JSON.parse(res.stdout.trim().split("\n").filter(Boolean).pop());
}

/** Least-squares slope of a metric against iteration, in bytes per parse. */
function slope(samples, key) {
  const n = samples.length;
  const mx = samples.reduce((s, p) => s + p.i, 0) / n;
  const my = samples.reduce((s, p) => s + p[key], 0) / n;
  let num = 0;
  let den = 0;
  for (const p of samples) {
    num += (p.i - mx) * (p[key] - my);
    den += (p.i - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

function summarise(arm) {
  const first = arm.samples[0];
  const last = arm.samples[arm.samples.length - 1];
  return {
    mode: arm.mode,
    heapPerParse: slope(arm.samples, "heapUsed"),
    rssPerParse: slope(arm.samples, "rss"),
    baselineMb: first.rss / MB,
    finalMb: last.rss / MB,
    heapGrowthMb: (last.heapUsed - first.heapUsed) / MB,
    rssGrowthMb: (last.rss - first.rss) / MB,
  };
}

console.log(`\nParsing a ${PAGES}-page PDF ${N}× per arm (warmup ${WARMUP}, sample every ${SAMPLE_EVERY}).`);
console.log("Three independent processes. 'retain' is a deliberate leak — it proves the harness sees one.\n");

const arms = ["fixed", "nodestroy", "retain"].map((m) => summarise(runArm(m)));
const [fixed, nodestroy, retain] = arms;

const row = (s) =>
  `  ${s.mode.padEnd(10)} ${s.baselineMb.toFixed(1).padStart(9)} ${s.finalMb
    .toFixed(1)
    .padStart(9)} ${s.rssGrowthMb.toFixed(1).padStart(9)} ${s.heapGrowthMb
    .toFixed(1)
    .padStart(10)} ${(s.rssPerParse / 1024).toFixed(1).padStart(13)}`;

console.log("  arm         base rss  final rss   Δrss MB   Δheap MB  rss KB/parse");
console.log("  " + "-".repeat(70));
for (const a of arms) console.log(row(a));

/**
 * Assertions are on HEAP, not rss.
 *
 * rss is what the process holds from the OS, and V8 does not hand pages back eagerly — a run can
 * show flat heap and several MB of rss drift purely from allocator fragmentation, which is not a
 * leak and not something this code can fix. Measured here: the `fixed` arm grew 3.9 MB of rss
 * while its heap moved 0.2 MB. Gating on rss would fail correct code and teach the next person to
 * raise the threshold until it stopped complaining.
 *
 * heapUsed is the JS-level retention this proof is actually about, and it discriminates far more
 * sharply: ~1.4 KB per parse for `fixed` against ~115 KB for `retain`. rss stays in the table as
 * context.
 */
const problems = [];

// 1. The instrument must be able to see a leak.
if (retain.heapPerParse < 20 * 1024) {
  problems.push(
    `the 'retain' arm grew only ${(retain.heapPerParse / 1024).toFixed(1)} KB of heap per parse ` +
      "while holding every document alive. The harness is not detecting retention, so a plateau " +
      "in 'fixed' would mean nothing. Fix the instrument before trusting any of these numbers.",
  );
}

// 2. Given it can, the real code must plateau — both in absolute terms and against the control.
const ratio = retain.heapPerParse / Math.max(fixed.heapPerParse, 1);
if (fixed.heapPerParse > 10 * 1024) {
  problems.push(
    `'fixed' grew ${(fixed.heapPerParse / 1024).toFixed(1)} KB of heap per parse across ${N} ` +
      "files — memory is not returning to baseline.",
  );
} else if (retain.heapPerParse >= 20 * 1024 && ratio < 10) {
  problems.push(
    `'fixed' heap growth is only ${ratio.toFixed(1)}× better than a deliberate leak — too close ` +
      "to call it a plateau.",
  );
}

console.log(
  `\n  retain/fixed heap growth ratio: ${Number.isFinite(ratio) ? ratio.toFixed(0) + "×" : "n/a"}`,
);
console.log(
  `  heap per parse — fixed ${(fixed.heapPerParse / 1024).toFixed(1)} KB, ` +
    `nodestroy ${(nodestroy.heapPerParse / 1024).toFixed(1)} KB, ` +
    `retain ${(retain.heapPerParse / 1024).toFixed(1)} KB`,
);
console.log(
  `  skipping the release cost ${(nodestroy.rssGrowthMb - fixed.rssGrowthMb).toFixed(1)} MB rss ` +
    `over ${N} parses (reported, not asserted — see the note at the top of this file).`,
);

if (problems.length > 0) {
  console.error("\nFAIL");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`\nPASS — heap is flat across ${N} sequential parses, on a harness demonstrably able`);
console.log("       to detect retention.\n");
