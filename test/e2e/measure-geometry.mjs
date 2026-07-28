import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

/**
 * Diagnostic for the visual diff: dumps the geometry and computed typography of every Quick
 * Notes element from both the prototype and the app, side by side, so a pixel difference can be
 * attributed to a specific rule instead of guessed at.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const PROTOTYPE = pathToFileURL(join(repoRoot, "docs/reference/trellis-prototype.html")).href;
const APP = process.env.APP_URL ?? "http://localhost:3000/notes";

const SELECTORS = [
  ".qn-input",
  ".qn-label",
  "textarea.paste",
  ".char",
  ".fmt-label",
  ".format-chips",
  ".format-chips .fmt",
  ".fmt-desc",
  ".gen-row",
  ".gen-row .btn-primary",
  ".gen-hint",
  ".gen-hint kbd",
  ".qn-output",
];

const PROPS = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "marginTop",
  "marginBottom",
  "paddingTop",
  "paddingBottom",
  "minHeight",
  "height",
  "borderTopWidth",
  "letterSpacing",
];

async function measure(page) {
  return page.evaluate(
    ({ selectors, props }) => {
      const out = {};
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (!el) {
          out[selector] = null;
          continue;
        }
        const rect = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const style = {};
        for (const p of props) style[p] = cs[p];
        out[selector] = {
          x: Math.round(rect.x * 100) / 100,
          y: Math.round(rect.y * 100) / 100,
          w: Math.round(rect.width * 100) / 100,
          h: Math.round(rect.height * 100) / 100,
          style,
        };
      }
      return out;
    },
    { selectors: SELECTORS, props: PROPS },
  );
}

const browser = await chromium.launch();
const viewport = { width: 1440, height: 900 };

const protoCtx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
const protoPage = await protoCtx.newPage();
await protoPage.goto(PROTOTYPE, { waitUntil: "networkidle" });
await protoPage.evaluate(() => {
  document.getElementById("landing").style.display = "none";
});
await protoPage.evaluate(() => document.fonts.ready);
const proto = await measure(protoPage);

const cookieSpec = process.env.SESSION_COOKIE;
const eq = cookieSpec.indexOf("=");
const appCtx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
await appCtx.addCookies([
  { name: cookieSpec.slice(0, eq), value: cookieSpec.slice(eq + 1), domain: "localhost", path: "/" },
]);
const appPage = await appCtx.newPage();
await appPage.goto(APP, { waitUntil: "networkidle" });
await appPage.evaluate(() => document.fonts.ready);
const app = await measure(appPage);

await browser.close();

// Report only what differs, and say by how much.
for (const selector of SELECTORS) {
  const p = proto[selector];
  const a = app[selector];
  if (!p || !a) {
    console.log(`${selector}\n  MISSING  proto=${!!p} app=${!!a}\n`);
    continue;
  }

  const geomDiffs = [];
  for (const k of ["x", "y", "w", "h"]) {
    const d = Math.round((a[k] - p[k]) * 100) / 100;
    if (Math.abs(d) >= 0.5) geomDiffs.push(`${k}: ${p[k]} → ${a[k]} (${d > 0 ? "+" : ""}${d})`);
  }

  const styleDiffs = [];
  for (const k of PROPS) {
    if (p.style[k] !== a.style[k]) styleDiffs.push(`${k}: "${p.style[k]}" → "${a.style[k]}"`);
  }

  if (geomDiffs.length || styleDiffs.length) {
    console.log(selector);
    for (const d of geomDiffs) console.log(`  GEOM  ${d}`);
    for (const d of styleDiffs) console.log(`  CSS   ${d}`);
    console.log("");
  }
}
