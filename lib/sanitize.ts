import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

/**
 * The single place model-generated text is made safe for the UI.
 *
 * `.claude/rules/ui.md`: "Sanitise all model output before dangerouslySetInnerHTML", and "escape
 * model-generated strings used in SVG `<text>` and in HTML attributes". `marked` does NOT
 * sanitise, and model output can be steered by text inside an uploaded document (the shared-PDF
 * attack), so every render of model content goes through one of the functions here.
 *
 * ── WHY sanitize-html AND NOT DOMPurify ─────────────────────────────────────────────────────
 *
 * DOMPurify needs a DOM. In the browser that is free; on the server it is not, and the previous
 * implementation therefore had a FAIL-CLOSED branch that emitted escaped `<pre>` text whenever
 * `document` was missing. That was correct but limiting: it made server-side sanitisation
 * impossible, so the only place model HTML could be neutralised was at client render — which is
 * the wrong seam once content is SHARED (see `sanitizeModelText` below). It was also a
 * container-deploy risk: the safety of the app depended on a browser global being present.
 *
 * `sanitize-html` parses with htmlparser2 and needs no DOM, so the SAME policy runs in a route
 * handler, in a Server Component and in the browser, and `sanitize-ssr.test.ts` now asserts the
 * output is byte-identical in both environments rather than asserting a degraded fallback.
 */

// Match the prototype's marked defaults (GFM on → tables, autolinks). No raw-HTML passthrough is
// needed: sanitize-html is the gate, not marked's options.
marked.setOptions({ gfm: true, breaks: false });

/**
 * Exactly the tags the prototype's `.prose` and `.def` rules style, plus the rest of what `marked`
 * emits for GFM. An allowlist rather than a denylist, for two reasons:
 *
 *  - permitting `<style>` would let model output ship CSS into the workspace (found by the payload
 *    corpus — it is not script execution, but it is a layout-hijack and data-exfiltration surface
 *    with no legitimate use here).
 *  - `<img>` is absent on purpose. Nothing in the design renders model-authored images, and
 *    dropping the element removes the `<img src=x onerror=…>` class of vector at the root rather
 *    than relying on attribute scrubbing.
 */
const ALLOWED_TAGS = [
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "br", "hr",
  "ul", "ol", "li",
  "strong", "b", "em", "i", "del", "s",
  "code", "pre",
  "blockquote",
  "table", "thead", "tbody", "tr", "th", "td",
  "a",
];

const BASE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  /** `href` for links, `title` for tooltips. No `style`, no `class`, no `on*`. */
  allowedAttributes: { a: ["href", "title"], "*": ["title"] },
  /** Blocks `javascript:`, `vbscript:` and `data:` URLs at the scheme level. */
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesAppliedToAttributes: ["href", "src", "cite", "action"],
  /**
   * Drop the CONTENTS of these, not just the tag. A stripped `<style>` must not leave its CSS
   * behind as visible text in the notes, and a stripped `<script>` must not leave its source.
   */
  nonTextTags: ["style", "script", "textarea", "option", "noscript", "title"],
  disallowedTagsMode: "discard",
  // No `<iframe>` is allowed at all, so there is nothing to configure here; listed explicitly so
  // a future edit cannot quietly re-enable one via a hostname allowlist.
  allowedIframeHostnames: [],
};

/**
 * Markdown → sanitised HTML, for `dangerouslySetInnerHTML`. Safe unconditionally, in any
 * environment.
 */
export function renderMarkdown(md: string): string {
  const html = marked.parse(md, { async: false });
  return sanitizeHtml(html, BASE_OPTIONS);
}

/**
 * Strip ALL markup from a model string, keeping its text.
 *
 * This is the SERVER-SIDE seam, and it is the one that matters most for the knowledge graph.
 * Concept detail is persisted (`concepts.detailJson`) and then DISTRIBUTED: the generation cache
 * is content-addressed on the document text, so a second user uploading the same PDF is served
 * the byte-identical stored detail, and `cloneGraphByContentHash` copies concept names and
 * summaries into their own rows. Sanitising only at render would leave the stored and cloned
 * payload dirty and make every present and future consumer — the panel, the export, the study
 * plan, the concept library, anything added later — individually responsible for remembering to
 * sanitise. Cleaning it once, before it is written, means there is no dirty copy to distribute.
 *
 * Markdown formatting survives untouched (`**bold**`, `- bullets`, `# headings` are not HTML), so
 * the panel still renders the model's intended structure. HTML in the source becomes entity-
 * encoded text, which `marked` passes through unchanged, so the reader sees the payload as
 * literal, inert prose — the same honest outcome the quiz surfaces already produce.
 */
export function sanitizeModelText(text: string): string {
  return sanitizeHtml(text, {
    allowedTags: [],
    allowedAttributes: {},
    nonTextTags: BASE_OPTIONS.nonTextTags,
    disallowedTagsMode: "discard",
  });
}

/**
 * A stored, sanitised string ready to be used as a REACT TEXT CHILD.
 *
 * `sanitizeModelText` leaves entities encoded, which is what makes the stored value inert. That
 * is right for storage and wrong for display: study material legitimately contains `<`, and
 * `"learning rate < 0.01"` is stored as `"learning rate &lt; 0.01"`. Handed to React as a text
 * child that renders literally, as the five characters `&lt;` — visible corruption of the user's
 * own material, and worst in exactly the maths-heavy documents this product is for.
 *
 * So the entities are decoded here, at the render boundary, and React escapes the result on
 * output. The round trip is a no-op for display and cannot produce markup.
 *
 * DECODING AT REST WOULD NOT BE SAFE, which is why it is not done there. A model that emits
 * already-encoded text — `&lt;img src=x onerror=…&gt;` — round-trips through sanitisation
 * unchanged, so decoding before storing would turn it back into tag-shaped markup in the
 * database, live for any future consumer that reaches for `innerHTML`. Decoding at the boundary
 * has no such consumer: the value exists only as an argument to React, which escapes it.
 *
 * NEVER pass the result of this to `dangerouslySetInnerHTML`. Markdown surfaces do not need it —
 * `marked` passes entities through untouched and the browser decodes them for free.
 */
const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

export function plainText(stored: string): string {
  // `&amp;` last would double-decode `&amp;lt;` into `<`; the single pass avoids that.
  return String(stored).replace(
    /&(?:amp|lt|gt|quot|#39|apos|nbsp);/g,
    (entity) => ENTITIES[entity] ?? entity,
  );
}

/**
 * Escape a model string for interpolation into an HTML/SVG ATTRIBUTE value, for the one place
 * that still builds markup by concatenation: the Word-compatible `.doc` wrapper in lib/export.ts.
 *
 * There is deliberately no matching `escapeText` for the SVG `<text>` node labels, even though
 * that is the surface `.claude/rules/ui.md` names. The components build those with JSX, where
 * React escapes children and attribute values itself — and applying an escaper first would
 * DOUBLE-escape, rendering `x < y` as the five visible characters `x &lt; y`. The right guard for
 * a React surface is a test that proves nothing executes, which is what the negative controls in
 * `knowledge-graph.sanitize.test.tsx` do: they render the prototype's own unescaped
 * string-concatenation template beside the component and show that one firing.
 */
export function escapeAttribute(value: string): string {
  return String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
