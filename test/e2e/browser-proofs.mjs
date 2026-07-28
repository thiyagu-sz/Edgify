import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

/**
 * The Phase 4 proofs that only a real browser can give.
 *
 * 1. mXSS in a real HTML parser. jsdom's parser is not Chrome's, and mutation XSS is precisely a
 *    parser-differential attack: markup that is inert when parsed once becomes live when the
 *    serialised output is parsed again. A jsdom pass is necessary but not sufficient, so the
 *    corpus is re-run here against the real component in the real engine.
 * 2. First token painted, measured from the browser rather than the server — the ~2s target is
 *    about what the user sees, and a client that buffers would satisfy a server-side
 *    measurement while showing nothing.
 * 3. Progressive rendering: the prose grows across multiple frames rather than appearing at once.
 *
 * Failures are reported per check and the process exits non-zero if any fails.
 *
 * Usage: SESSION_COOKIE=<name=value> node --env-file=.env.local test/e2e/browser-proofs.mjs
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const APP = process.env.APP_URL ?? "http://localhost:3000/notes";
const SAMPLE = readFileSync(join(repoRoot, "test/e2e/sample-text.txt"), "utf8").trim();

const results = [];
function record(name, passed, detail = "") {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/** Mirrors test/xss-payloads.ts. Duplicated here because this file runs outside vitest. */
const XSS_PAYLOADS = [
  ["script tag", "Notes.\n\n<script>window.__xss='script'</script>"],
  ["img onerror", '- point\n\n<img src=x onerror="window.__xss=\'img\'">'],
  ["svg onload", '<svg onload="window.__xss=\'svg\'"></svg>'],
  ["iframe javascript:", "<iframe src=\"javascript:window.__xss='iframe'\"></iframe>"],
  ["markdown javascript: link", "[click](javascript:window.__xss='mdlink')"],
  ["body onload", "<body onload=\"window.__xss='body'\">notes</body>"],
  ["details ontoggle", "<details open ontoggle=\"window.__xss='details'\">s</details>"],
  ["form formaction", "<form><button formaction=\"javascript:window.__xss='fa'\">go</button></form>"],
  ["nested script", "<scr<script>ipt>window.__xss='nested'</scr</script>ipt>"],
  ["style url()", "<style>body{background:url(\"javascript:window.__xss='style'\")}</style>"],
  // The mutation vectors — the whole reason this file exists.
  [
    "mXSS math/mtext/mglyph/style",
    "<math><mtext><table><mglyph><style><!--</style><img title=\"--&gt;&lt;/mtext&gt;&lt;img src=x onerror=window.__xss='mxss'&gt;\">",
  ],
  [
    "mXSS noscript title breakout",
    "<noscript><p title=\"</noscript><img src=x onerror=window.__xss='noscript'>\"></p></noscript>",
  ],
  [
    "mXSS svg foreignObject",
    "<svg><foreignObject><![CDATA[</foreignObject><img src=x onerror=window.__xss='fo'>]]></foreignObject></svg>",
  ],
];

function cookieFromEnv() {
  const spec = process.env.SESSION_COOKIE;
  if (!spec) throw new Error("SESSION_COOKIE is not set (see test/e2e/seed-session.mjs)");
  const eq = spec.indexOf("=");
  return { name: spec.slice(0, eq), value: spec.slice(eq + 1), domain: "localhost", path: "/" };
}

async function newPage(browser, cookie) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([cookie]);
  const page = await ctx.newPage();

  // Any dialog at all means something executed. Fail loudly rather than auto-dismissing.
  page.on("dialog", async (d) => {
    record("no dialog was raised", false, `dialog appeared: "${d.message()}"`);
    await d.dismiss();
  });
  page.on("pageerror", (err) => {
    record("no uncaught page error", false, String(err).slice(0, 200));
  });

  return { ctx, page };
}

async function fillAndGenerate(page, { format } = {}) {
  await page.getByRole("button", { name: /load sample/i }).click();
  if (format) await page.getByRole("button", { name: format, exact: true }).click();
  await page.getByRole("button", { name: /generate revision notes/i }).click();
}

// ── 1. mXSS through the real component ───────────────────────────────────────

async function proveXssProse(browser, cookie) {
  const { ctx, page } = await newPage(browser, cookie);

  const combined = XSS_PAYLOADS.map(([, p]) => p).join("\n\n");
  await page.route("**/api/notes/generate", (route) =>
    route.fulfill({
      status: 200,
      headers: { "X-Trellis-Kind": "stream", "X-Trellis-Tier": "free" },
      contentType: "text/plain; charset=utf-8",
      body: `## Notes\n\n${combined}`,
    }),
  );

  await page.goto(APP, { waitUntil: "networkidle" });
  await fillAndGenerate(page);
  await page.locator(".prose").waitFor();
  await page.waitForTimeout(1500); // give any deferred handler (onerror, ontoggle) time to fire

  const verdict = await page.evaluate(() => {
    const root = document.querySelector(".qn-output");
    const offenders = [];
    for (const tag of ["script", "iframe", "object", "embed", "style"]) {
      if (root.querySelector(tag)) offenders.push(`<${tag}> survived`);
    }
    for (const el of root.querySelectorAll("*")) {
      for (const attr of el.attributes) {
        if (attr.name.toLowerCase().startsWith("on")) {
          offenders.push(`${el.tagName}[${attr.name}]`);
        }
        if (/^\s*(javascript|vbscript|data:text\/html)/i.test(attr.value)) {
          offenders.push(`${el.tagName}[${attr.name}]="${attr.value.slice(0, 40)}"`);
        }
      }
    }
    return { xss: window.__xss ?? null, offenders };
  });

  record(
    "prose: no payload executed in a real browser",
    verdict.xss === null,
    verdict.xss === null ? `${XSS_PAYLOADS.length} payloads` : `window.__xss = ${verdict.xss}`,
  );
  record(
    "prose: no executable markup survived the real parser",
    verdict.offenders.length === 0,
    verdict.offenders.join("; "),
  );

  await ctx.close();
}

async function proveXssQuiz(browser, cookie) {
  const { ctx, page } = await newPage(browser, cookie);

  const quiz = {
    questions: XSS_PAYLOADS.slice(0, 3).map(([name, payload], i) => ({
      q: `${name} ${payload}`,
      options: XSS_PAYLOADS.slice(0, 4).map(([, p]) => `opt ${p}`),
      answer: i % 4,
      explanation: `why ${payload}`,
    })),
  };

  await page.route("**/api/notes/generate", (route) =>
    route.fulfill({
      status: 200,
      headers: { "X-Trellis-Kind": "final" },
      contentType: "application/json",
      body: JSON.stringify({ data: quiz, tier: "free", notice: null }),
    }),
  );

  await page.goto(APP, { waitUntil: "networkidle" });
  await fillAndGenerate(page, { format: "MCQs" });
  await page.locator(".quiz-q").first().waitFor();
  await page.locator(".q-opt").first().click(); // render the explanation surface too
  await page.locator(".q-fb").first().waitFor();
  await page.waitForTimeout(1000);

  const verdict = await page.evaluate(() => {
    const root = document.querySelector(".qn-output");
    const offenders = [];
    for (const el of root.querySelectorAll("*")) {
      for (const attr of el.attributes) {
        if (attr.name.toLowerCase().startsWith("on")) offenders.push(`${el.tagName}[${attr.name}]`);
      }
    }
    return { xss: window.__xss ?? null, offenders, scripts: root.querySelectorAll("script").length };
  });

  record("quiz: no payload executed in a real browser", verdict.xss === null,
    verdict.xss === null ? "" : `window.__xss = ${verdict.xss}`);
  record("quiz: no handlers or scripts in the rendered quiz",
    verdict.offenders.length === 0 && verdict.scripts === 0, verdict.offenders.join("; "));

  await ctx.close();
}

// ── 2. First token painted, measured in the browser ──────────────────────────

async function proveFirstPaint(browser, cookie) {
  const { ctx, page } = await newPage(browser, cookie);

  const SERVER_DELAY_MS = 300;
  await page.route("**/api/notes/generate", async (route) => {
    await new Promise((r) => setTimeout(r, SERVER_DELAY_MS));
    await route.fulfill({
      status: 200,
      headers: { "X-Trellis-Kind": "stream", "X-Trellis-Tier": "free" },
      contentType: "text/plain; charset=utf-8",
      body: "## Key points\n\n- Backpropagation applies the chain rule.\n- Gradient descent lowers the loss.",
    });
  });

  await page.goto(APP, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /load sample/i }).click();

  // Timestamp the moment the first text lands inside .prose, from inside the page.
  await page.evaluate(() => {
    window.__firstPaint = null;
    window.__clickAt = null;
    const observer = new MutationObserver(() => {
      const prose = document.querySelector(".prose");
      if (prose && prose.textContent.trim().length > 0 && window.__firstPaint === null) {
        window.__firstPaint = performance.now();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  });

  await page.evaluate(() => {
    window.__clickAt = performance.now();
  });
  await page.getByRole("button", { name: /generate revision notes/i }).click();
  await page.locator(".prose").waitFor();
  await page.waitForFunction(() => window.__firstPaint !== null);

  const elapsed = await page.evaluate(() => window.__firstPaint - window.__clickAt);
  // The stub adds SERVER_DELAY_MS deliberately; what is being proven is that the CLIENT adds
  // almost nothing on top, so the end-to-end figure tracks model latency rather than our
  // rendering.
  const clientOverhead = elapsed - SERVER_DELAY_MS;
  record(
    "first token painted within the budget",
    elapsed < 2000,
    `${elapsed.toFixed(0)}ms total (${SERVER_DELAY_MS}ms stubbed server, ${clientOverhead.toFixed(0)}ms client)`,
  );

  await ctx.close();
}

/**
 * Progressive rendering, against the LIVE model.
 *
 * Deliberately unstubbed. Playwright's `route.fulfill` hands over a complete body, so the client
 * reads it in a single chunk and a stubbed "progressive" check passes whether or not the UI can
 * actually stream — it proves nothing. The only way to observe progressive rendering is a
 * response that genuinely arrives in pieces, which means the real route and the real model.
 *
 * This spends a small number of real tokens, and doubles as the browser-side first-token
 * measurement: what the user actually waits for, end to end.
 */
async function proveProgressive(browser, cookie) {
  const { ctx, page } = await newPage(browser, cookie);
  await page.goto(APP, { waitUntil: "networkidle" });

  // Unique text so the ladder cannot serve a cache hit (which would return instantly, buffered).
  const unique = `${SAMPLE}\n\nRun id ${Date.now()}-${Math.random().toString(36).slice(2)}.`;
  await page.locator("textarea.paste").fill(unique);

  await page.evaluate(() => {
    window.__samples = [];
    window.__clickAt = null;
    const observer = new MutationObserver(() => {
      const prose = document.querySelector(".prose");
      if (prose) {
        window.__samples.push({ t: performance.now(), len: prose.textContent.length });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await page.evaluate(() => {
    window.__clickAt = performance.now();
  });

  await page.getByRole("button", { name: /generate revision notes/i }).click();
  await page.locator(".prose").waitFor({ timeout: 45_000 });
  // Wait for the stream to settle: no growth for 2s.
  await page.waitForFunction(
    () => {
      const s = window.__samples;
      if (s.length === 0) return false;
      return performance.now() - s[s.length - 1].t > 2000;
    },
    { timeout: 60_000 },
  );

  const { samples, clickAt } = await page.evaluate(() => ({
    samples: window.__samples,
    clickAt: window.__clickAt,
  }));

  const distinctLengths = new Set(samples.map((s) => s.len));
  const firstPaintMs = samples.length ? samples[0].t - clickAt : Infinity;
  const finalLength = samples.length ? samples[samples.length - 1].len : 0;

  record(
    "live model: prose grows across multiple updates (genuinely progressive)",
    distinctLengths.size >= 3,
    `${samples.length} DOM updates, ${distinctLengths.size} distinct lengths, final ${finalLength} chars`,
  );
  record(
    "live model: first token painted within ~2s",
    firstPaintMs < 2000,
    `${firstPaintMs.toFixed(0)}ms`,
  );

  await ctx.close();
  return { firstPaintMs, updates: samples.length, finalLength };
}

// ── main ─────────────────────────────────────────────────────────────────────

const cookie = cookieFromEnv();
const browser = await chromium.launch();

await proveXssProse(browser, cookie);
await proveXssQuiz(browser, cookie);
await proveFirstPaint(browser, cookie);
await proveProgressive(browser, cookie);

await browser.close();

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exit(1);
