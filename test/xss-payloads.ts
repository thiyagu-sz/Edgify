/**
 * The XSS payload corpus, shared by every sanitisation proof (unit, component and browser) so
 * all three attack the same surface and none can drift into testing a weaker set.
 *
 * The threat model is the one in `.claude/rules/ui.md`: a lecture PDF carries injected text, a
 * classmate uploads it, the model echoes the payload into its output, and it renders in the
 * classmate's session — and the shared dedupe cache can then serve it to everyone with that
 * file. So these stand in for MODEL OUTPUT, not for user input.
 *
 * Every payload tries to set `window.__xss`. That sentinel is the assertion: after rendering, if
 * `window.__xss` is defined, script executed. String matching alone is not enough — it proves
 * only that one spelling was stripped, not that nothing ran.
 */

declare global {
  interface Window {
    /** Set only if an injected payload executed. Any defined value is a test failure. */
    __xss?: unknown;
  }
}

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
};

export const XSS_PAYLOADS: XssPayload[] = [
  {
    name: "script tag",
    payload: "Some notes.\n\n<script>window.__xss = 'script'</script>\n\nMore notes.",
  },
  {
    name: "img onerror",
    payload: '- A key point\n\n<img src=x onerror="window.__xss=\'img\'">',
  },
  {
    name: "svg onload",
    payload: '<svg onload="window.__xss=\'svg\'"></svg>',
  },
  {
    name: "iframe javascript: src",
    payload: "<iframe src=\"javascript:window.__xss='iframe'\"></iframe>",
  },
  {
    name: "markdown link with javascript: href",
    payload: "[click me](javascript:window.__xss='mdlink')",
  },
  {
    name: "raw anchor with data:text/html href",
    payload:
      '<a href="data:text/html;base64,PHNjcmlwdD53aW5kb3cuX194c3M9J2RhdGEnPC9zY3JpcHQ+">doc</a>',
  },
  {
    name: "body onload",
    payload: "<body onload=\"window.__xss='body'\">notes</body>",
  },
  {
    name: "details ontoggle",
    payload: "<details open ontoggle=\"window.__xss='details'\">summary</details>",
  },
  {
    name: "form button formaction",
    payload:
      "<form><button formaction=\"javascript:window.__xss='formaction'\">go</button></form>",
  },
  {
    name: "nested/broken script tag",
    payload: "<scr<script>ipt>window.__xss='nested'</scr</script>ipt>",
  },
  {
    name: "style block with url()",
    payload: "<style>body{background:url(\"javascript:window.__xss='style'\")}</style>",
  },
  {
    // The canonical mXSS vector: mglyph/style inside a table inside mtext makes some parsers
    // re-interpret the comment boundary on a second parse, resurrecting the img tag.
    name: "mXSS — math/mtext/mglyph/style",
    payload:
      "<math><mtext><table><mglyph><style><!--</style><img title=\"--&gt;&lt;/mtext&gt;&lt;img src=x onerror=window.__xss='mxss'&gt;\">",
    mutation: true,
  },
  {
    name: "mXSS — noscript title breakout",
    payload:
      "<noscript><p title=\"</noscript><img src=x onerror=window.__xss='noscript'>\"></p></noscript>",
    mutation: true,
  },
  {
    name: "mXSS — svg foreignObject re-parse",
    payload:
      "<svg><foreignObject><![CDATA[</foreignObject><img src=x onerror=window.__xss='fo'>]]></foreignObject></svg>",
    mutation: true,
  },
];

/** Every payload concatenated — the "model echoed the whole poisoned document" case. */
export const ALL_PAYLOADS_COMBINED = XSS_PAYLOADS.map((p) => p.payload).join("\n\n");

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
 * Complements the `window.__xss` sentinel: the sentinel proves nothing ran this time, this
 * catches a vector that survived but happened not to fire (an `onerror` whose src resolved).
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
 * The no-DOM (fail-closed) equivalent: with no parser available we cannot inspect a tree, so we
 * require the output to be fully escaped — no raw tag can be present at all.
 */
export function assertFullyEscaped(html: string): void {
  const inner = html.replace(/^<pre>/, "").replace(/<\/pre>$/, "");
  if (/<[a-z!/]/i.test(inner)) {
    throw new Error(`raw markup present in fail-closed output: ${inner.slice(0, 400)}`);
  }
}
