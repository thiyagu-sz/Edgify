/**
 * The XSS payload corpus, shared by every sanitisation proof (unit, component and browser) so
 * all three attack the same surface and none can drift into testing a weaker set.
 *
 * The threat model is the one in `.claude/rules/ui.md`: a lecture PDF carries injected text, a
 * classmate uploads it, the model echoes the payload into its output, and it renders in the
 * classmate's session — and the shared dedupe cache can then serve it to everyone with that
 * file. So these stand in for MODEL OUTPUT, not for user input.
 *
 * ── THE SENTINEL, AND WHY IT IS NO LONGER `window.__xss` ────────────────────────────────────
 *
 * Every payload sets a sentinel; after rendering, if the sentinel is set, script executed. String
 * matching alone is not enough — it proves only that one spelling was stripped, not that nothing
 * ran.
 *
 * The sentinel used to be `window.__xss`, and in this repo's component environment THAT
 * ASSERTION COULD NEVER FAIL. Measured 2026-07-31, not assumed: jsdom compiles an injected inline
 * handler (`typeof img.onerror === "function"`, and its source is the payload) and invoking it
 * runs the payload — but the `window` it writes to is jsdom's own realm global, which is not the
 * object vitest exposes to the test file. `window.__xss` therefore read `undefined` no matter
 * what executed. Setting `environmentOptions.jsdom.runScripts: "dangerously"` changes nothing.
 * So every `expect(window.__xss).toBeUndefined()` in a component test passed identically against
 * a completely unsanitised renderer, and `assertNoExecutableDom` was doing all the real work.
 *
 * `document.title` DOES cross that boundary (verified alongside the above, together with
 * `document.body.setAttribute` and `documentElement.dataset`), because it is a property of the
 * shared document rather than of a realm global. So the corpus writes there, `xssFired()` reads
 * BOTH channels — the document marker and the legacy `window.__xss`, which is the natural one in
 * a real browser — and a negative control can now fire in CI rather than only under Playwright.
 *
 * One vector stays browser-only: jsdom answers a `javascript:` href click with "Not implemented"
 * rather than evaluating it. That is why `test/e2e/*-proofs.mjs` exist and why a jsdom pass is
 * necessary but never sufficient.
 */

declare global {
  interface Window {
    /** Legacy channel. Works in a real browser; see the note above for why jsdom needs the other. */
    __xss?: unknown;
  }
}

/** Marker written into `document.title` by every payload. */
export const XSS_MARKER = "EDGIFY-XSS";

export type XssPayload = {
  /** Short name, used in test titles. */
  name: string;
  /** Stands in for a chunk of model output. */
  payload: string;
  /**
   * True when the payload relies on a parser differential (HTML re-parsing producing different
   * markup the second time). jsdom's parser is not Chrome's, so these are ALSO exercised in the
   * real-browser run — jsdom passing them is necessary, not sufficient.
   */
  mutation?: boolean;
  /**
   * True when the vector cannot fire under jsdom at all (see the `javascript:` note above), so a
   * negative control must not expect it to. It still must not survive sanitisation.
   */
  browserOnly?: boolean;
  /**
   * True when the vector cannot fire through `innerHTML` in ANY engine — not a jsdom limitation
   * but the HTML specification: a `<script>` inserted by `innerHTML` is never executed, and a
   * `<body>` nested inside a `<div>` is dropped by the parser before its handler can land.
   *
   * They stay in the corpus for two reasons. The sanitiser must still strip them — a surviving
   * `<script>` is a latent bug the moment anyone changes the injection path. And that path does
   * change: server-rendered HTML, `document.write`, and `insertAdjacentHTML` into a parser
   * context all execute what `innerHTML` does not. Marked rather than removed, so the negative
   * control neither expects them to fire nor silently stops testing them.
   */
  innerHtmlInert?: boolean;
};

/** The JS every payload runs. Kept in one place so no payload can drift to a weaker sentinel. */
function fire(id: string): string {
  return `document.title='${XSS_MARKER}:${id}'`;
}

export const XSS_PAYLOADS: XssPayload[] = [
  {
    name: "script tag",
    payload: `Some notes.\n\n<script>${fire("script")}</script>\n\nMore notes.`,
    innerHtmlInert: true,
  },
  {
    name: "img onerror",
    payload: `- A key point\n\n<img src=x onerror="${fire("img")}">`,
  },
  {
    name: "svg onload",
    payload: `<svg onload="${fire("svg")}"></svg>`,
  },
  {
    name: "iframe javascript: src",
    payload: `<iframe src="javascript:${fire("iframe")}"></iframe>`,
    browserOnly: true,
  },
  {
    name: "markdown link with javascript: href",
    payload: `[click me](javascript:${fire("mdlink")})`,
    browserOnly: true,
  },
  {
    name: "raw anchor with data:text/html href",
    payload:
      '<a href="data:text/html;base64,PHNjcmlwdD5kb2N1bWVudC50aXRsZT0nRURHSUZZLVhTUzpkYXRhJzwvc2NyaXB0Pg==">doc</a>',
    browserOnly: true,
  },
  {
    name: "body onload",
    payload: `<body onload="${fire("body")}">notes</body>`,
    innerHtmlInert: true,
  },
  {
    name: "details ontoggle",
    payload: `<details open ontoggle="${fire("details")}">summary</details>`,
  },
  {
    name: "form button formaction",
    payload: `<form><button formaction="javascript:${fire("formaction")}">go</button></form>`,
    browserOnly: true,
  },
  {
    name: "nested/broken script tag",
    payload: `<scr<script>ipt>${fire("nested")}</scr</script>ipt>`,
    innerHtmlInert: true,
  },
  {
    name: "style block with url()",
    payload: `<style>body{background:url("javascript:${fire("style")}")}</style>`,
    browserOnly: true,
  },
  {
    // The canonical mXSS vector: mglyph/style inside a table inside mtext makes some parsers
    // re-interpret the comment boundary on a second parse, resurrecting the img tag.
    name: "mXSS — math/mtext/mglyph/style",
    payload:
      "<math><mtext><table><mglyph><style><!--</style><img title=\"--&gt;&lt;/mtext&gt;&lt;img src=x onerror=document.title='EDGIFY-XSS:mxss'&gt;\">",
    mutation: true,
    // jsdom's parser does not reproduce the re-parse differential this depends on; Chromium does.
    browserOnly: true,
  },
  {
    name: "mXSS — noscript title breakout",
    payload:
      "<noscript><p title=\"</noscript><img src=x onerror=document.title='EDGIFY-XSS:noscript'>\"></p></noscript>",
    mutation: true,
  },
  {
    name: "mXSS — svg foreignObject re-parse",
    payload:
      "<svg><foreignObject><![CDATA[</foreignObject><img src=x onerror=document.title='EDGIFY-XSS:fo'>]]></foreignObject></svg>",
    mutation: true,
  },
];

/** Every payload concatenated — the "model echoed the whole poisoned document" case. */
export const ALL_PAYLOADS_COMBINED = XSS_PAYLOADS.map((p) => p.payload).join("\n\n");

/**
 * Payloads that can fire under jsdom once their event is dispatched. A negative control asserts
 * these DO fire, so the control cannot silently become a no-op.
 */
export const JSDOM_FIREABLE_PAYLOADS = XSS_PAYLOADS.filter(
  (p) => !p.browserOnly && !p.innerHtmlInert,
);

/**
 * Where a breakout payload is CAPABLE of firing.
 *
 * A payload that escapes a double-quoted attribute cannot escape a single-quoted one, and neither
 * escapes an SVG `<text>` node the way a `</text>` sequence does. Recording this per payload keeps
 * the negative controls honest in both directions: each control asserts every payload that CAN
 * fire in its context does, and never demands a fire from one that structurally cannot — which
 * would either be a false failure or, worse, pressure to weaken the assertion.
 */
export type BreakoutContext = "svg-text" | "attr-double" | "attr-single";

export type BreakoutPayload = XssPayload & { contexts: BreakoutContext[] };

/** Short, quoted strings for the surfaces that carry a NAME or a SLUG rather than a document. */
export const ATTRIBUTE_BREAKOUT_PAYLOADS: BreakoutPayload[] = [
  {
    name: "attribute breakout — svg onload",
    payload: `"><svg onload="${fire("attr-svg")}"></svg><span x="`,
    contexts: ["svg-text", "attr-double"],
  },
  {
    name: "attribute breakout — img onerror",
    payload: `"><img src=x onerror="${fire("attr-img")}"><span x="`,
    contexts: ["svg-text", "attr-double"],
  },
  {
    name: "attribute breakout — single-quoted",
    // Escapes `data-id='…'`; inside a double-quoted attribute the `'` is just a character, so
    // this one is exercised by the single-quoted control only. Note the handler body uses DOUBLE
    // quotes: written with `fire()` like its siblings, the payload's own single quotes would
    // terminate the attribute early and leave `document.title=` — a syntax error rather than an
    // attack, which is a control that fails for the wrong reason.
    payload: `'><img src=x onerror='document.title="${XSS_MARKER}:attr-sq"'><span x='`,
    contexts: ["attr-single"],
  },
  {
    name: "element breakout — closes the text node",
    payload: `</text><image href=x onerror="${fire("svg-text")}"/><text>`,
    contexts: ["svg-text", "attr-double"],
  },
  {
    name: "element breakout — script after close",
    // Kept in the corpus because the sanitiser must still strip it, but a `<script>` inserted by
    // `innerHTML` is never executed in ANY engine (see `innerHtmlInert`), so no control can
    // require it to fire.
    payload: `</text><script>${fire("svg-script")}</script><text>`,
    contexts: [],
    innerHtmlInert: true,
  },
];

/** The breakout payloads that can fire in a given context. */
export function breakoutsFor(context: BreakoutContext): BreakoutPayload[] {
  return ATTRIBUTE_BREAKOUT_PAYLOADS.filter((p) => p.contexts.includes(context));
}

// ── Sentinel plumbing ────────────────────────────────────────────────────────

let baselineTitle = "";

/** Clear both channels. Called around every test so one leak cannot mask another. */
export function resetXssSentinel(): void {
  if (typeof document !== "undefined") {
    baselineTitle = "";
    document.title = "";
    document.body?.removeAttribute("data-xss");
    document.documentElement?.removeAttribute("data-xss");
  }
  if (typeof window !== "undefined") delete window.__xss;
}

/**
 * The marker if a payload executed, else null. Reads BOTH channels: the document marker (the one
 * that works under jsdom) and the legacy realm global (the natural one in a real browser).
 */
export function xssFired(): string | null {
  if (typeof window !== "undefined" && window.__xss !== undefined) {
    return `window.__xss=${String(window.__xss)}`;
  }
  if (typeof document === "undefined") return null;
  if (document.title.startsWith(XSS_MARKER)) return document.title;
  if (document.body?.getAttribute("data-xss")) return `body[data-xss]`;
  if (document.documentElement?.getAttribute("data-xss")) return `html[data-xss]`;
  return baselineTitle && document.title !== baselineTitle ? document.title : null;
}

/**
 * Dispatch the events a real browser fires on its own.
 *
 * jsdom loads no subresources, so an injected `<img src=x>` never errors and an `<svg>` never
 * loads — the handler is compiled and simply never invoked. Driving those events here is what
 * makes a jsdom negative control able to fire at all; in Chromium the same payloads fire
 * unassisted, which is what `test/e2e/graph-proofs.mjs` checks.
 *
 * Deliberately applied IDENTICALLY to the dirty and clean runs: the only difference between them
 * is the renderer, never the driver. A clean render simply has no such elements to dispatch on.
 */
export function fireDeferredHandlers(root: ParentNode): void {
  for (const el of root.querySelectorAll("img, image, source, script, link, input")) {
    el.dispatchEvent(new Event("error"));
    el.dispatchEvent(new Event("load"));
  }
  for (const el of root.querySelectorAll("svg, body, iframe, object, embed, video, audio")) {
    el.dispatchEvent(new Event("load"));
  }
  for (const el of root.querySelectorAll("details")) {
    el.dispatchEvent(new Event("toggle"));
  }
  // Anything still carrying an inline handler: fire the event it names.
  for (const el of root.querySelectorAll("*")) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        el.dispatchEvent(new Event(name.slice(2), { bubbles: true }));
      }
    }
  }
  // Only elements the ATTACK created: a `javascript:` URL is activated by a click, and nothing
  // else here is. Clicking every `button` instead would drive the application's own controls —
  // Regenerate, Try again, quiz options — and the driver would be changing the state it is
  // supposed to be observing (it did: it consumed the quiz clicks these tests make themselves).
  for (const el of root.querySelectorAll('a[href^="javascript:"]')) {
    (el as HTMLElement).click();
  }
}

/**
 * Let asynchronously-queued handlers run, then report the sentinel.
 *
 * NOT optional, and the reason is a bug this caught in its own test suite. `<details open>` queues
 * its `toggle` event as a TASK rather than firing it during parsing, so an injected
 * `<details open ontoggle=…>` executes on a later tick — after the test that rendered it has
 * finished, and even after the element has been detached from the document. The payload then
 * lands in whichever test happens to be running at the time, which presents as a completely
 * unrelated test failing with a marker it never rendered and no offending element anywhere in its
 * DOM. Flushing here keeps each test's payloads inside that test.
 */
export async function flushDeferredHandlers(): Promise<string | null> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return xssFired();
}

const URL_ATTRS = ["href", "src", "action", "formaction", "xlink:href", "data"];
const DANGEROUS_URL = /^\s*(javascript:|data:text\/html|vbscript:)/i;
// `style` is included deliberately: model output has no legitimate need to author CSS into the
// prose panel, and a surviving <style> block is a data-exfiltration and layout-hijack surface
// even though it is not script execution.
const EXECUTABLE_TAGS = [
  "script",
  "iframe",
  "object",
  "embed",
  "frame",
  "frameset",
  "style",
];

/**
 * Assert that a PARSED subtree carries nothing executable.
 *
 * Deliberately DOM-based rather than string-based. Sanitised output legitimately contains text
 * like `&lt;img src=x onerror=…` — the attack rendered as visible, inert prose, which is a pass,
 * not a failure. A regex over the HTML string cannot tell that apart from a live handler, so it
 * reports the safe case as dangerous and teaches you to loosen the check. Reading attributes off
 * the parsed tree asks the question that actually matters: does the browser see a handler?
 *
 * Complements the sentinel: the sentinel proves nothing ran this time, this catches a vector that
 * survived but happened not to fire (an `onerror` whose src resolved).
 */
export function assertNoExecutableDom(root: ParentNode): void {
  for (const tag of EXECUTABLE_TAGS) {
    const found = root.querySelector(tag);
    if (found) throw new Error(`<${tag}> survived sanitisation`);
  }

  for (const el of root.querySelectorAll("*")) {
    for (const attr of el.attributes) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        throw new Error(
          `inline handler survived: <${el.tagName.toLowerCase()} ${name}="${attr.value}">`,
        );
      }
      if (URL_ATTRS.includes(name) && DANGEROUS_URL.test(attr.value)) {
        throw new Error(
          `dangerous URL survived: <${el.tagName.toLowerCase()} ${name}="${attr.value}">`,
        );
      }
    }
  }
}

/** Parse `html` in a detached container and assert nothing executable survived. */
export function assertNoExecutableMarkup(html: string): void {
  const host = document.createElement("div");
  host.innerHTML = html;
  assertNoExecutableDom(host);
}

/**
 * Render `html` into the LIVE document the way a component does, drive the deferred handlers a
 * browser would drive, and report the sentinel. Used by both the dirty control and the real
 * render so the two differ only in who produced the markup.
 */
export function renderAndFire(html: string): { fired: string | null; host: HTMLElement } {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  fireDeferredHandlers(host);
  return { fired: xssFired(), host };
}
