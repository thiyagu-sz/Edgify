import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { chromium } from "playwright";

/**
 * Phase 4 acceptance: "side-by-side with edgify-prototype.html, the UI is visually
 * indistinguishable".
 *
 * Renders the SAME state in both the prototype and the real app and pixel-diffs the Quick Notes
 * region. The prototype calls a live Claude endpoint that does not exist here, so identical
 * content cannot be obtained by generating on both sides. Instead each side is driven to a state
 * with the same fixed fixture: the prototype through its own globals (setOutput /
 * renderQuizOutput), the app through an intercepted /api/notes/generate.
 *
 * The number reported is the share of differing pixels per state. It is REPORTED, not silently
 * thresholded — anti-aliasing and font hinting make an exact zero unreachable, and a pass/fail
 * line chosen to make the run go green would prove nothing. Regions that differ are written out
 * as diff PNGs for inspection.
 *
 * Usage: node --env-file=.env.local test/e2e/visual-diff.mjs
 *        SESSION_COOKIE=<name=value> must be set (see seed-session.mjs).
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const OUT_DIR = join(repoRoot, ".artifacts", "visual-diff");
const PROTOTYPE = pathToFileURL(
  join(repoRoot, "docs", "reference", "edgify-prototype.html"),
).href;
const APP = process.env.APP_URL ?? "http://localhost:3000/notes";

const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1280x800", width: 1280, height: 800 },
];

/**
 * Differences that are deliberate, and why. Printed with every run so a residual diff is never
 * mistaken for an unexplained one — and so that if any of these is ever resolved, the leftover
 * entry is obvious.
 */
const KNOWN_DEVIATIONS = [
  '"Upload file" renders disabled (grey) — file upload is Phase 5. Accounts for the constant ' +
    "~170px floor present in every state.",
  'Error-state heading: the prototype uses one generic "Couldn\'t generate the notes" for every ' +
    'failure; the app uses the specific docs/04 §7 catalogue title ("The server is busy", ' +
    '"Session expired", "Check the source material"). Distinct honest messages are required by ' +
    "the resilience spec, which supersedes the prototype's placeholder copy.",
  'Textarea scroll offset after "Load sample": the prototype assigns .value then .focus(), ' +
    "scrolling to the caret at the end; React sets the value by re-render, so the app shows the " +
    "start of the sample. Same content, caret and focus. Normalised before capture.",
];

/** The fixed fixture both sides render. Markdown exercising every .prose rule. */
const PROSE_FIXTURE = `## Neural networks

- A network has an **input layer**, hidden layers, and an **output layer**.
- Each connection carries a weight; each neuron computes a weighted sum.
- Nonlinear activations let the network model \`nonlinear\` relationships.

### Training

1. A loss function measures prediction error.
2. Backpropagation applies the chain rule, output to input.
3. Gradient descent nudges each weight toward lower loss.

> The learning rate sets step size: too large is unstable, too small converges slowly.`;

const QUIZ_FIXTURE = {
  questions: [
    {
      q: "What does a nonlinear activation function let a network do?",
      options: ["Model nonlinear relationships", "Skip the loss function", "Avoid training", "Remove all weights"],
      answer: 0,
      explanation: "Without nonlinearity, stacked linear layers collapse into a single linear map.",
    },
    {
      q: "What does the loss function measure?",
      options: ["The number of layers", "How far predictions fall from the targets", "The learning rate", "The batch size"],
      answer: 1,
      explanation: "Training minimises this measure of prediction error.",
    },
  ],
};

// Both sides load the sample through their own "Load sample" button, so the fixture file is not
// read here — it is the prototype's SAMPLE constant, extracted for the other e2e scripts.

// ── Prototype drivers ────────────────────────────────────────────────────────
// The prototype is a single page of globals; drive it the way its own event handlers do.

/**
 * The prototype boots on the dark landing page and the workspace sits behind it, so it must be
 * switched into the app before anything is comparable. The prototype's own `launch()` just hides
 * #landing (proto:1323); calling it directly is the same transition its button performs.
 */
async function enterProtoWorkspace(page) {
  await page.evaluate(() => {
    document.getElementById("landing").style.display = "none";
    window.scrollTo(0, 0);
  });
  await page.locator("#feature-notes").waitFor({ state: "visible" });
}

const protoStates = {
  async empty() {},

  async sampleLoaded(page) {
    await page.evaluate(() => document.getElementById("sampleBtn").click());
  },

  async loading(page) {
    await page.evaluate(() => {
      document.getElementById("sampleBtn").click();
      // The prototype's generate() disables the button for the duration (proto:943). Calling
      // loadingState() alone would leave it enabled and make the app's correctly-disabled
      // button look like a difference it is not.
      document.getElementById("genBtn").disabled = true;
      loadingState("Generating key points…");
    });
  },

  async prose(page, { markdown }) {
    await page.evaluate(
      ({ markdown }) => {
        document.getElementById("sampleBtn").click();
        const fmt = FORMATS.find((f) => f.id === "key_points");
        lastExport = { title: "Edgify — " + fmt.label, md: markdown };
        const html = marked.parse(markdown);
        setOutput(
          outputHeader(fmt) + `<div class="out-body"><div class="prose">${html}</div></div>`,
        );
        wireOutputTools(fmt);
      },
      { markdown },
    );
  },

  async quiz(page, { quiz }) {
    await page.evaluate(
      ({ quiz }) => {
        document.getElementById("sampleBtn").click();
        // Select the format through its own chip handler, so aria-pressed and the format
        // description update exactly as a user click would. Assigning `qnFormat` directly would
        // leave the chips showing Key Points and the app's correct MCQs selection would read as
        // a difference.
        document.querySelector('.fmt[data-f="mcqs"]').click();
        renderQuizOutput(
          FORMATS.find((f) => f.id === "mcqs"),
          JSON.stringify(quiz),
        );
      },
      { quiz },
    );
  },

  async quizAnswered(page, { quiz }) {
    await protoStates.quiz(page, { quiz });
    await page.evaluate(() => {
      const cards = document.querySelectorAll(".quiz-q");
      cards[0].querySelectorAll(".q-opt")[0].click(); // correct
      cards[1].querySelectorAll(".q-opt")[3].click(); // wrong
    });
  },

  async error(page) {
    await page.evaluate(() => {
      document.getElementById("sampleBtn").click();
      errorState("Server is busy, please try again in a moment.");
    });
  },
};

// ── App drivers ──────────────────────────────────────────────────────────────

const appStates = {
  async empty() {},

  async sampleLoaded(page) {
    await page.getByRole("button", { name: /load sample/i }).click();
  },

  async loading(page) {
    await page.getByRole("button", { name: /load sample/i }).click();
    await page.route("**/api/notes/generate", () => {
      /* never fulfil: hold the loading state */
    });
    await page.getByRole("button", { name: /generate revision notes/i }).click();
    await page.locator(".spin").waitFor();
  },

  async prose(page, { markdown }) {
    await page.route("**/api/notes/generate", (route) =>
      route.fulfill({
        status: 200,
        headers: { "X-Edgify-Kind": "stream", "X-Edgify-Tier": "free" },
        contentType: "text/plain; charset=utf-8",
        body: markdown,
      }),
    );
    await page.getByRole("button", { name: /load sample/i }).click();
    await page.getByRole("button", { name: /generate revision notes/i }).click();
    await page.locator(".prose").waitFor();
  },

  async quiz(page, { quiz }) {
    await page.route("**/api/notes/generate", (route) =>
      route.fulfill({
        status: 200,
        headers: { "X-Edgify-Kind": "final" },
        contentType: "application/json",
        body: JSON.stringify({ data: quiz, tier: "free", notice: null }),
      }),
    );
    await page.getByRole("button", { name: /load sample/i }).click();
    await page.getByRole("button", { name: "MCQs" }).click();
    await page.getByRole("button", { name: /generate revision notes/i }).click();
    await page.locator(".quiz-q").first().waitFor();
  },

  async quizAnswered(page, { quiz }) {
    await appStates.quiz(page, { quiz });
    const cards = page.locator(".quiz-q");
    await cards.nth(0).locator(".q-opt").nth(0).click();
    await cards.nth(1).locator(".q-opt").nth(3).click();
    await page.locator(".q-fb").first().waitFor();
  },

  async error(page) {
    await page.route("**/api/notes/generate", (route) =>
      route.fulfill({
        status: 200,
        headers: { "X-Edgify-Kind": "busy" },
        contentType: "application/json",
        body: JSON.stringify({ message: "Server is busy, please try again in a moment." }),
      }),
    );
    await page.getByRole("button", { name: /load sample/i }).click();
    await page.getByRole("button", { name: /generate revision notes/i }).click();
    await page.locator(".errbox").waitFor();
  },
};

const STATES = [
  { name: "01-empty", args: {} },
  { name: "02-sample-loaded", args: {} },
  { name: "03-loading", args: {} },
  { name: "04-prose", args: { markdown: PROSE_FIXTURE } },
  { name: "05-quiz", args: { quiz: QUIZ_FIXTURE } },
  { name: "06-quiz-answered", args: { quiz: QUIZ_FIXTURE } },
  { name: "07-error", args: {} },
];

const STATE_KEYS = {
  "01-empty": "empty",
  "02-sample-loaded": "sampleLoaded",
  "03-loading": "loading",
  "04-prose": "prose",
  "05-quiz": "quiz",
  "06-quiz-answered": "quizAnswered",
  "07-error": "error",
};

/**
 * Both pages must render with the same fonts before any comparison is meaningful. The prototype
 * pulls Inter and JetBrains Mono from Google Fonts; the app self-hosts the same faces through
 * next/font. Wait for both to settle rather than racing the swap.
 */
async function waitForFonts(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}

/** Freeze anything that would differ between two captures for reasons that are not design. */
async function stabilise(page) {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
      }
      /* The spinner is mid-rotation at capture time; pin it to a fixed angle so the loading
         state is comparable at all. */
      .spin { animation: none !important; transform: rotate(0deg) !important; }
    `,
  });
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo(0, 0);

    // Normalise textarea scroll offset. This is NOT a design difference and is documented as a
    // known deviation: after "Load sample" the prototype's textarea ends up scrolled to the
    // bottom, because it assigns `.value` then calls `.focus()`, which scrolls to the caret at
    // the end of the text. React sets the value through a re-render, so the app shows the top of
    // the sample instead. Same content, same caret, same focus — only the scroll offset differs,
    // and showing the start of what you just loaded is the better of the two. Comparing at a
    // shared offset keeps the diff measuring design rather than that one behaviour.
    for (const t of document.querySelectorAll("textarea")) t.scrollTop = 0;

    // Same reasoning for the output panel, which can be mid-scroll after long content.
    for (const el of document.querySelectorAll(".out-body")) el.scrollTop = 0;
  });
}

async function capture(page, selector, file) {
  await stabilise(page);
  await waitForFonts(page);
  const target = page.locator(selector);
  await target.waitFor();
  await target.screenshot({ path: file, animations: "disabled", caret: "hide" });
}

function compare(protoFile, appFile, diffFile) {
  const a = PNG.sync.read(readFileSync(protoFile));
  const b = PNG.sync.read(readFileSync(appFile));

  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const sizeMismatch = a.width !== b.width || a.height !== b.height;

  const crop = (png) => {
    if (png.width === width && png.height === height) return png;
    const out = new PNG({ width, height });
    PNG.bitblt(png, out, 0, 0, width, height, 0, 0);
    return out;
  };

  const ca = crop(a);
  const cb = crop(b);
  const diff = new PNG({ width, height });
  const differing = pixelmatch(ca.data, cb.data, diff.data, width, height, {
    threshold: 0.1,
    includeAA: false,
  });
  writeFileSync(diffFile, PNG.sync.write(diff));

  return {
    differing,
    total: width * height,
    ratio: differing / (width * height),
    protoSize: `${a.width}x${a.height}`,
    appSize: `${b.width}x${b.height}`,
    sizeMismatch,
  };
}

async function main() {
  const cookieSpec = process.env.SESSION_COOKIE;
  if (!cookieSpec) throw new Error("SESSION_COOKIE is not set (see test/e2e/seed-session.mjs)");
  const eq = cookieSpec.indexOf("=");
  const cookie = {
    name: cookieSpec.slice(0, eq),
    value: cookieSpec.slice(eq + 1),
    domain: "localhost",
    path: "/",
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const results = [];

  for (const viewport of VIEWPORTS) {
    for (const state of STATES) {
      const key = STATE_KEYS[state.name];
      const dir = join(OUT_DIR, viewport.name);
      mkdirSync(dir, { recursive: true });

      // Prototype
      const protoCtx = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
      });
      const protoPage = await protoCtx.newPage();
      await protoPage.goto(PROTOTYPE, { waitUntil: "networkidle" });
      await enterProtoWorkspace(protoPage);
      await protoStates[key](protoPage, state.args);
      const protoFile = join(dir, `${state.name}.prototype.png`);
      await capture(protoPage, "#feature-notes .qn-grid", protoFile);
      await protoCtx.close();

      // App
      const appCtx = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
      });
      await appCtx.addCookies([cookie]);
      const appPage = await appCtx.newPage();
      await appPage.goto(APP, { waitUntil: "networkidle" });
      await appStates[key](appPage, state.args);
      const appFile = join(dir, `${state.name}.app.png`);
      await capture(appPage, ".qn-grid", appFile);
      await appCtx.close();

      const diffFile = join(dir, `${state.name}.diff.png`);
      const result = compare(protoFile, appFile, diffFile);
      results.push({ viewport: viewport.name, state: state.name, ...result });
      console.log(
        `${viewport.name} ${state.name.padEnd(18)} ` +
          `diff=${(result.ratio * 100).toFixed(3)}% (${result.differing}/${result.total}) ` +
          `proto=${result.protoSize} app=${result.appSize}` +
          (result.sizeMismatch ? "  SIZE MISMATCH" : ""),
      );
    }
  }

  await browser.close();

  const worst = results.reduce((a, b) => (b.ratio > a.ratio ? b : a));
  console.log(`\nWorst state: ${worst.viewport} ${worst.state} at ${(worst.ratio * 100).toFixed(3)}%`);
  console.log("\nKnown, deliberate deviations:");
  for (const [i, note] of KNOWN_DEVIATIONS.entries()) console.log(`  ${i + 1}. ${note}`);

  writeFileSync(
    join(OUT_DIR, "results.json"),
    JSON.stringify({ results, knownDeviations: KNOWN_DEVIATIONS }, null, 2),
  );
  console.log(`\nArtifacts: ${OUT_DIR}`);
}

await main();
