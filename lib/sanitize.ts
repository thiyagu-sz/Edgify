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

export function renderMarkdown(md: string): string {
  const html = marked.parse(md, { async: false });
  return DOMPurify.sanitize(html);
}
