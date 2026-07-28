import DOMPurify from "dompurify";
import { marked } from "marked";

/**
 * The single place model-generated markdown becomes HTML for the UI.
 *
 * `.claude/rules/ui.md`: "Sanitise all model output before dangerouslySetInnerHTML." `marked`
 * does NOT sanitise, and model output can be steered by text inside an uploaded document (the
 * shared-PDF attack), so every prose render — including each progressive streaming tick — goes
 * through here. DOMPurify strips `<script>`, `on*` handlers, `javascript:` URLs and the like,
 * leaving only the formatting tags the prototype's `.prose` styles target.
 *
 * Runs client-side (DOMPurify needs a DOM); the unit test runs it under jsdom.
 */

// Match the prototype's marked defaults (GFM on → tables, autolinks). No raw-HTML passthrough is
// needed: DOMPurify is the gate, not marked's options.
marked.setOptions({ gfm: true, breaks: false });

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

/**
 * Markdown → sanitised HTML. Returns a string intended for `dangerouslySetInnerHTML`, so it must
 * be safe unconditionally.
 *
 * FAIL CLOSED: DOMPurify needs a DOM, and without one it cannot strip anything. Today this is
 * only ever called from a client component after a fetch resolves, so SSR never reaches it — but
 * that is a property of the current render order, not a guarantee. If the DOM is missing we
 * escape the markdown and return it as preformatted text: the output is inert and legible rather
 * than unsanitised HTML handed to innerHTML.
 */
/**
 * Exactly the tags the prototype's `.prose` rules style, plus the rest of what `marked` emits
 * for GFM. An allowlist rather than DOMPurify's defaults, for two reasons:
 *
 *  - DOMPurify's default profile permits `<style>`, so model output could ship CSS into the
 *    workspace (found by the payload corpus — it is not script execution, but it is a
 *    layout-hijack and data-exfiltration surface with no legitimate use here).
 *  - `<img>` is absent on purpose. Nothing in the design renders model-authored images, and
 *    dropping the element removes the `<img src=x onerror=…>` class of vector at the root
 *    rather than relying on attribute scrubbing.
 */
const ALLOWED_TAGS = [
  // Required explicitly: with a custom allowlist and KEEP_CONTENT off, DOMPurify treats text
  // nodes like any other node and drops every one of them without this.
  "#text",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "br", "hr",
  "ul", "ol", "li",
  "strong", "b", "em", "i", "del", "s",
  "code", "pre",
  "blockquote",
  "table", "thead", "tbody", "tr", "th", "td",
  "a",
];

/** `href` for links, `title` for tooltips. No `style`, no `class`, no `on*`. */
const ALLOWED_ATTR = ["href", "title"];

export function renderMarkdown(md: string): string {
  if (!DOMPurify.isSupported) {
    return `<pre>${escapeHtml(md)}</pre>`;
  }
  const html = marked.parse(md, { async: false });
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // Drop the contents of removed elements too: a stripped <style> must not leave its CSS
    // behind as visible text in the notes.
    KEEP_CONTENT: false,
  });
}
