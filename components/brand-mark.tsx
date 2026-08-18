/**
 * The Edgify mark, and the arrow that sits inside every marketing call to action.
 *
 * EXTRACTED, NOT REDESIGNED. Both lived in `app/(marketing)/page.tsx`, whose comment recorded the
 * rule this file now keeps: "the mark is passed in so this file keeps the single copy of that SVG".
 * `SiteFooter` takes the mark as a prop precisely so it is not duplicated — but that only worked
 * while exactly one page rendered the footer. The SEO landing pages are the second and third, so
 * the single copy moves here rather than becoming three copies.
 *
 * The paths are byte-identical to the prototype's (docs/reference/edgify-prototype.html, the visual
 * specification per `.claude/rules/ui.md`). Nothing about the rendered output changes.
 *
 * Both are decorative: every place they appear, the surrounding text already names the action, so
 * they carry `aria-hidden` or are announced by their link's own label.
 */

/**
 * The triangle mark. `accentThirdNode` paints the lower-right node blue — the dark/marketing
 * treatment. The app top bar draws it in ink instead (see `edgify-logo-assets/README.md`).
 */
export function BrandMark({ accentThirdNode = true }: { accentThirdNode?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <line x1="12" y1="5.5" x2="5.5" y2="17.5" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
      <line x1="12" y1="5.5" x2="18.5" y2="17.5" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
      <line x1="5.5" y1="17.5" x2="18.5" y2="17.5" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="12" cy="5.5" r="2.7" fill="#fff" />
      <circle cx="5.5" cy="17.5" r="2.7" fill="#fff" />
      <circle cx="18.5" cy="17.5" r="2.7" fill={accentThirdNode ? "#60a5fa" : "#fff"} />
    </svg>
  );
}

/** The trailing arrow on `.lx-btn-primary` and `.lx-btn-glass`. */
export function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <path d="M4 12h16m0 0l-6-6m6 6l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The tick used in `.lx-check` rows and `.lx-mode` lists. */
export function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
