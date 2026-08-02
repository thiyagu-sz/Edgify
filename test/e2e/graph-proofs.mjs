import { chromium } from "playwright";

/**
 * The Phase 5 graph proofs that only a real browser can give.
 *
 * 1. PANEL SCROLL CONTAINMENT. `overscroll-behavior: contain` is a layout behaviour; jsdom has no
 *    layout engine, so `lib/graph/panel-scroll.test.ts` can only check that the declaration is
 *    present and matches the prototype's. Whether the PAGE actually stays put when the panel is
 *    scrolled to its end needs Chromium — and the negative control here removes the declaration
 *    at runtime and shows the page moving, which is the failure the criterion is about.
 *
 * 2. XSS THAT FIRES UNASSISTED. Under jsdom the component tests must dispatch `error`/`load`
 *    themselves, because jsdom loads no subresources. Chromium fires them on its own, and its
 *    parser is the one the mutation-XSS payloads target. A jsdom pass is necessary, never
 *    sufficient (the same reasoning as browser-proofs.mjs for Quick Notes).
 *
 * Both the graph payload and the concept detail are stubbed at the network boundary, so this
 * needs a session but no particular graph in the database.
 *
 * Usage: SESSION_COOKIE=<name=value> node --env-file=.env.local test/e2e/graph-proofs.mjs
 */

const APP = process.env.APP_URL ?? "http://localhost:3000";
const GRAPH_ID = "00000000-0000-4000-8000-000000000001";

const results = [];
function record(name, passed, detail = "") {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/** Mirrors test/xss-payloads.ts. Duplicated because this file runs outside vitest. */
const MARKER = "EDGIFY-XSS";
const fire = (id) => `document.title='${MARKER}:${id}'`;

const PAYLOADS = [
  ["img onerror", `<img src=x onerror="${fire("img")}">`],
  ["svg onload", `<svg onload="${fire("svg")}"></svg>`],
  ["script tag", `<script>${fire("script")}</script>`],
  ["details ontoggle", `<details open ontoggle="${fire("details")}">s</details>`],
  ["iframe javascript:", `<iframe src="javascript:${fire("iframe")}"></iframe>`],
  ["markdown javascript: link", `[click](javascript:${fire("mdlink")})`],
  ["style url()", `<style>body{background:url("javascript:${fire("style")}")}</style>`],
  [
    "mXSS math/mtext/mglyph/style",
    `<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;/mtext&gt;&lt;img src=x onerror=document.title='${MARKER}:mxss'&gt;">`,
  ],
  [
    "mXSS noscript title breakout",
    `<noscript><p title="</noscript><img src=x onerror=document.title='${MARKER}:noscript'>"></p></noscript>`,
  ],
  [
    "mXSS svg foreignObject",
    `<svg><foreignObject><![CDATA[</foreignObject><img src=x onerror=document.title='${MARKER}:fo'>]]></foreignObject></svg>`,
  ],
];
const COMBINED = PAYLOADS.map(([, p]) => p).join("\n\n");

/** Breakout strings for the SVG-text and attribute contexts. */
const BREAKOUTS = [
  `"><img src=x onerror="${fire("attr-img")}"><span x="`,
  `"><svg onload="${fire("attr-svg")}"></svg><span x="`,
  `</text><image href=x onerror="${fire("svg-text")}"/><text>`,
];

function cookieFromEnv() {
  const spec = process.env.SESSION_COOKIE;
  if (!spec) throw new Error("SESSION_COOKIE is not set (see test/e2e/seed-session.mjs)");
  const eq = spec.indexOf("=");
  return { name: spec.slice(0, eq), value: spec.slice(eq + 1), domain: "localhost", path: "/" };
}

async function newPage(browser, cookie, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addCookies([cookie]);
  const page = await ctx.newPage();
  page.on("dialog", async (d) => {
    record("no dialog was raised", false, `dialog appeared: "${d.message()}"`);
    await d.dismiss();
  });
  return { ctx, page };
}

/** A graph with enough concepts to make the panel taller than the viewport. */
function graphPayload(poisoned) {
  const name = (i) =>
    poisoned ? `Concept ${i} ${BREAKOUTS[i % BREAKOUTS.length]}` : `Concept ${i}`;
  const concepts = Array.from({ length: 6 }, (_, i) => ({
    id: `00000000-0000-4000-8000-00000000000${i + 2}`,
    slug: poisoned ? `slug-${i}-${BREAKOUTS[i % BREAKOUTS.length]}` : `slug-${i}`,
    name: name(i),
    difficulty: ["Foundational", "Intermediate", "Advanced"][i % 3],
    summary: poisoned ? `Summary ${COMBINED}` : `Summary of concept ${i}.`,
    estimatedMinutes: 120,
    layoutX: 24 + (i % 3) * 170,
    layoutY: 20 + Math.floor(i / 3) * 94,
    layoutW: 146,
    hasDetail: false,
  }));
  return {
    status: "ready",
    title: poisoned ? `Topic ${COMBINED}` : "Machine learning",
    concepts,
    edges: [
      { prerequisite: concepts[0].slug, dependent: concepts[3].slug },
      { prerequisite: concepts[1].slug, dependent: concepts[4].slug },
    ],
    mastery: [],
  };
}

function detailPayload(poisoned) {
  const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} of the explanation.`).join("\n\n");
  return {
    status: "ready",
    cached: false,
    detail: {
      definition: poisoned ? `A definition.\n\n${COMBINED}\n\n${long}` : `A definition.\n\n${long}`,
      example: poisoned ? COMBINED : "An example.",
      quiz: {
        q: poisoned ? `Which ${BREAKOUTS[0]}?` : "Which one?",
        options: poisoned ? [`A ${BREAKOUTS[1]}`, `B ${BREAKOUTS[2]}`] : ["A", "B"],
        answer: 0,
        explanation: poisoned ? `Because ${COMBINED}` : "Because.",
      },
      flashcards: [
        { front: poisoned ? `Front ${BREAKOUTS[0]}` : "Front", back: poisoned ? `Back ${COMBINED}` : "Back" },
      ],
    },
  };
}

async function stubGraph(page, poisoned) {
  await page.route(`**/api/graph/${GRAPH_ID}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(graphPayload(poisoned)),
    }),
  );
  await page.route("**/api/concepts/*/detail", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(detailPayload(poisoned)),
    }),
  );
}

// ── 1. Panel scroll containment ──────────────────────────────────────────────

async function provePanelScroll(browser, cookie) {
  // A short viewport, so the panel is genuinely a bounded scroller and the page is long enough
  // to have somewhere to scroll to.
  const { ctx, page } = await newPage(browser, cookie, { width: 1280, height: 700 });
  await stubGraph(page, false);

  await page.goto(`${APP}/graph?g=${GRAPH_ID}`, { waitUntil: "networkidle" });
  await page.locator(".panel .def").waitFor();

  const geometry = await page.evaluate(() => {
    const panel = document.querySelector(".panel");
    const style = getComputedStyle(panel);
    return {
      overscroll: style.overscrollBehaviorY,
      position: style.position,
      scrollable: panel.scrollHeight > panel.clientHeight,
      pageScrollable: document.documentElement.scrollHeight > window.innerHeight,
    };
  });

  record(
    "panel is a bounded, scrollable region (premise of the next check)",
    geometry.scrollable && geometry.pageScrollable,
    `panel scrollable: ${geometry.scrollable}, page scrollable: ${geometry.pageScrollable}`,
  );
  record(
    "computed overscroll-behavior is `contain`",
    geometry.overscroll === "contain",
    geometry.overscroll,
  );
  record("computed position is `sticky`", geometry.position === "sticky", geometry.position);

  /** Wheel inside the panel until it hits its end, then keep wheeling. */
  async function scrollPanelToEndAndBeyond() {
    await page.evaluate(() => window.scrollTo(0, 0));
    const box = await page.locator(".panel").boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 40; i++) await page.mouse.wheel(0, 200);
    // Give the scroll chain a chance to propagate if it is going to.
    await page.waitForTimeout(400);
    return page.evaluate(() => ({
      pageY: window.scrollY,
      panelY: document.querySelector(".panel").scrollTop,
    }));
  }

  const contained = await scrollPanelToEndAndBeyond();
  record(
    "scrolling the panel to its end does not move the page behind it",
    contained.pageY === 0 && contained.panelY > 0,
    `page scrollY ${contained.pageY}, panel scrollTop ${contained.panelY}`,
  );

  // ── NEGATIVE CONTROL — remove the one declaration and the page moves ───────
  await page.addStyleTag({ content: ".panel { overscroll-behavior: auto !important; }" });
  const uncontained = await scrollPanelToEndAndBeyond();
  record(
    "NEGATIVE CONTROL: without `overscroll-behavior: contain` the page DOES move",
    uncontained.pageY > 0,
    uncontained.pageY > 0
      ? `page scrolled to ${uncontained.pageY}`
      : "the control did not move the page — this proof is not measuring what it claims",
  );

  await ctx.close();
}

// ── 2. XSS, firing unassisted in a real engine ───────────────────────────────

async function proveGraphXss(browser, cookie) {
  const { ctx, page } = await newPage(browser, cookie);
  await stubGraph(page, true);

  await page.goto(`${APP}/graph?g=${GRAPH_ID}`, { waitUntil: "networkidle" });
  await page.locator("svg.graph").waitFor();
  await page.locator(".panel .def").waitFor();

  // Visit every surface: the panel tabs, the library and the plan.
  await page.getByRole("tab", { name: "Quiz", exact: true }).click();
  await page.locator(".q-opt").first().click();
  await page.locator(".q-fb").first().waitFor();
  await page.getByRole("tab", { name: "Cards", exact: true }).click();
  await page.getByRole("tab", { name: "Concepts", exact: true }).click();
  await page.locator(".cc").first().waitFor();
  await page.getByRole("tab", { name: "Study plan", exact: true }).click();
  // `exact: true` throughout: the top bar's "Knowledge graph" link is also role="tab", so a
  // substring match on "Graph" is ambiguous and Playwright's strict mode rejects it.
  await page.getByRole("tab", { name: "Graph", exact: true }).click();
  // `force: true` because an SVG <g>'s own <text> child intercepts pointer events, so
  // Playwright's actionability check never settles. The click still reaches React's handler on
  // the <g>; what is being exercised here is the panel re-render, not hit-testing.
  await page.locator(".node-g").nth(3).click({ force: true });

  // Chromium fires img/svg/details handlers on its own — no dispatching here, deliberately.
  await page.waitForTimeout(2000);

  const verdict = await page.evaluate((marker) => {
    const offenders = [];
    for (const tag of ["script", "iframe", "object", "embed", "style"]) {
      const found = document.querySelectorAll(`main ${tag}`).length;
      if (found > 0) offenders.push(`<${tag}> ×${found}`);
    }
    for (const el of document.querySelectorAll("main *")) {
      for (const attr of el.attributes) {
        if (attr.name.toLowerCase().startsWith("on")) offenders.push(`${el.tagName}[${attr.name}]`);
        if (/^\s*(javascript|vbscript|data:text\/html)/i.test(attr.value)) {
          offenders.push(`${el.tagName}[${attr.name}]="${attr.value.slice(0, 40)}"`);
        }
      }
    }
    return { fired: document.title.startsWith(marker) ? document.title : null, offenders };
  }, MARKER);

  record(
    "graph: no payload executed in a real browser",
    verdict.fired === null,
    verdict.fired ?? `${PAYLOADS.length} payloads across every surface`,
  );
  record(
    "graph: no executable markup survived the real parser",
    verdict.offenders.length === 0,
    verdict.offenders.join("; "),
  );

  // ── NEGATIVE CONTROL — the same payloads, unescaped, in the same engine ────
  const controlFired = await page.evaluate(
    async ({ combined, breakouts, marker }) => {
      document.title = "";
      const host = document.createElement("div");
      // The prototype's own templates, with escapeHtml removed.
      host.innerHTML =
        `<svg viewBox="0 0 760 200"><g class="node-g" aria-label="${breakouts[0]}">` +
        `<text class="lbl">${breakouts[2]}</text></g></svg>` +
        `<div class="def">${combined}</div>`;
      document.body.appendChild(host);
      await new Promise((r) => setTimeout(r, 1500));
      const fired = document.title.startsWith(marker) ? document.title : null;
      host.remove();
      document.title = "";
      return fired;
    },
    { combined: COMBINED, breakouts: BREAKOUTS, marker: MARKER },
  );

  record(
    "NEGATIVE CONTROL: the same payloads DO execute unescaped, unassisted",
    controlFired !== null,
    controlFired ?? "the control did not fire — this proof is not measuring what it claims",
  );

  await ctx.close();
}

// ── main ─────────────────────────────────────────────────────────────────────

const cookie = cookieFromEnv();
const browser = await chromium.launch();

await provePanelScroll(browser, cookie);
await proveGraphXss(browser, cookie);

await browser.close();

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exit(1);
