/**
 * One pinned input/output pair for `renderMarkdown`, asserted from BOTH test environments.
 *
 * `lib/sanitize.test.ts` runs under jsdom; `lib/sanitize-ssr.test.ts` runs under node with no
 * `document` at all. Both assert this exact string, which is what turns "sanitisation works on
 * the server too" from a claim into a check: if the two environments ever produce different
 * HTML, one of the two suites fails with a diff rather than the difference going unnoticed.
 *
 * That property is the entire reason the sanitiser is `sanitize-html` rather than DOMPurify —
 * see the note in lib/sanitize.ts.
 */
export const CROSS_ENV_INPUT =
  "## Heading\n\n" +
  "- **bold** point\n" +
  "- <img src=x onerror=\"document.title='EDGIFY-XSS:fixture'\">\n\n" +
  "<script>document.title='EDGIFY-XSS:fixture2'</script>\n\n" +
  "[safe](https://example.com) and [bad](javascript:boom())\n";

export const CROSS_ENV_OUTPUT =
  "<h2>Heading</h2>\n" +
  "<ul>\n" +
  "<li><strong>bold</strong> point</li>\n" +
  "<li></li>\n" +
  "</ul>\n" +
  "<p><a href=\"https://example.com\">safe</a> and <a>bad</a></p>\n";
