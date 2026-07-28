import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

/**
 * "When the model fails, the UI falls back to calm sample notes with a visible banner, never a
 * spinner that never resolves." Proven by breaking the model on purpose, in the real app.
 *
 * The break is a CONFIG break, applied by the caller through the environment the server was
 * started with — no test-only branch, no stubbed route, no mock. The server genuinely cannot
 * reach a working model, walks the real degradation ladder, and the browser sees whatever a user
 * would see.
 *
 * MODE=demo   every model id points at something that does not exist → tier 5
 * MODE=badkey the API key is invalid → 401, non-retryable → tier 5
 * MODE=quota  the daily limit is spent → quota banner over demo content
 *
 * Usage: MODE=demo SESSION_COOKIE=<name=value> node test/e2e/degradation-proof.mjs
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const APP = process.env.APP_URL ?? "http://localhost:3000/notes";
const MODE = process.env.MODE ?? "demo";
const SAMPLE = readFileSync(join(repoRoot, "test/e2e/sample-text.txt"), "utf8").trim();
const SHOT_DIR = join(repoRoot, ".artifacts", "degradation");

const results = [];
function record(name, passed, detail = "") {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/** docs/04 §7 — failure machinery that must never reach the user. Shapes, not bare words: the
 *  notes are about neural networks and legitimately mention prediction "error". */
const FORBIDDEN = [
  [/openrouter/i, "vendor name"],
  [/\bHTTP\s*\d{3}\b/i, "HTTP status code"],
  [/\b(401|402|429|500|502|503)\b/, "raw status number"],
  [/rate.?limit/i, "rate-limit wording"],
  [/quota exceeded/i, "quota as an error"],
  [/\berror:/i, "raw error prefix"],
  [/\bat\s+\w+\s*\(.*:\d+:\d+\)/, "stack frame"],
  [/\bundefined\b/, "undefined rendered"],
  [/\[object Object\]/, "object rendered"],
];

const EXPECTED = {
  demo: {
    banner: /Showing sample content/,
    detail: "Live generation is temporarily unavailable",
  },
  badkey: {
    banner: /Showing sample content/,
    detail: "Live generation is temporarily unavailable",
  },
  quota: {
    banner: /You've used today's generations/,
    detail: "Here's a worked example in the meantime",
  },
};

const cookieSpec = process.env.SESSION_COOKIE;
if (!cookieSpec) throw new Error("SESSION_COOKIE is not set");
const eq = cookieSpec.indexOf("=");
const cookie = {
  name: cookieSpec.slice(0, eq),
  value: cookieSpec.slice(eq + 1),
  domain: "localhost",
  path: "/",
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([cookie]);
const page = await ctx.newPage();

// The browser must never talk to the model provider directly (.claude/rules/ai.md).
const providerRequests = [];
page.on("request", (r) => {
  if (/openrouter\.ai|api\.anthropic\.com|api\.openai\.com/.test(r.url())) {
    providerRequests.push(r.url());
  }
});
page.on("dialog", async (d) => {
  record("no dialog raised", false, d.message());
  await d.dismiss();
});

await page.goto(APP, { waitUntil: "networkidle" });
await page.locator("textarea.paste").fill(`${SAMPLE}\n\nRun ${Date.now()}.`);

const startedAt = Date.now();
await page.getByRole("button", { name: /generate revision notes/i }).click();

// The whole point: this must RESOLVE. Wait for a terminal state, not for success.
await page.waitForFunction(
  () => document.querySelector(".prose, .quiz-q, .errbox") !== null,
  { timeout: 60_000 },
);
const elapsed = Date.now() - startedAt;

const state = await page.evaluate(() => {
  const banner = document.querySelector(".notice-banner");
  return {
    spinnerVisible: document.querySelector(".spin") !== null,
    bannerText: banner?.textContent?.trim() ?? null,
    bannerVisible: banner ? banner.getBoundingClientRect().height > 0 : false,
    proseText: document.querySelector(".prose")?.textContent?.trim() ?? "",
    errBox: document.querySelector(".errbox")?.textContent?.trim() ?? null,
    // innerText, NOT textContent: textContent includes the text of <script> elements, and
    // Next.js inlines its RSC payload there. That payload legitimately contains `$undefined`
    // markers and numbers like `fontWeight:500`, which a textContent scan reports as a leaked
    // status code. What the rule is about is what the USER can read, which is innerText.
    visibleText: document.body.innerText ?? "",
    toolsEnabled: Array.from(document.querySelectorAll(".out-tools button")).map((b) => ({
      label: b.textContent.trim(),
      enabled: !b.disabled,
    })),
  };
});

const expected = EXPECTED[MODE];

record("the spinner resolved", !state.spinnerVisible, `${elapsed}ms to a terminal state`);
record(
  "a visible banner labels the result",
  state.bannerVisible && expected.banner.test(state.bannerText ?? ""),
  state.bannerText ? state.bannerText.slice(0, 90) : "no banner rendered",
);
record(
  "the banner explains and reassures",
  (state.bannerText ?? "").includes(expected.detail),
  expected.detail,
);
record(
  "real sample content is rendered, not an error box",
  state.proseText.length > 100 && state.errBox === null,
  `${state.proseText.length} chars of prose`,
);
record(
  "the content is genuinely the curated sample",
  /Backpropagation|loss function|learning rate/i.test(state.proseText),
  state.proseText.slice(0, 60).replace(/\s+/g, " "),
);
record(
  "export and regenerate remain usable (demo is interactive)",
  state.toolsEnabled.length >= 3 && state.toolsEnabled.every((t) => t.enabled),
  state.toolsEnabled.map((t) => t.label).join(", "),
);

const leaks = FORBIDDEN.filter(([pattern]) => pattern.test(state.visibleText)).map(([, d]) => d);
record("no failure machinery is visible to the user", leaks.length === 0, leaks.join("; "));
record(
  "the browser never contacted the model provider",
  providerRequests.length === 0,
  providerRequests.join(", "),
);

await page.screenshot({ path: join(SHOT_DIR, `${MODE}.png`), fullPage: false });
await browser.close();

const failed = results.filter((r) => !r.passed);
console.log(`\nMODE=${MODE}: ${results.length - failed.length}/${results.length} checks passed`);
console.log(`Screenshot: ${join(SHOT_DIR, `${MODE}.png`)}`);
if (failed.length > 0) process.exit(1);
