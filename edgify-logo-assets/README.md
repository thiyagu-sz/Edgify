# Edgify — logo assets

Production assets for the **existing** Edgify logo. Nothing here is a new design.
The mark is the prototype's own inline SVG, coordinate for coordinate; the wordmark is
the prototype's own type, outlined.

**Source of truth:** `docs/reference/edgify-prototype.html`
— landing nav (line 451), landing footer (line 609), app top bar (line 620).
The same mark already ships in `components/top-bar.tsx` and `app/(marketing)/page.tsx`.

---

## The three files that matter

| Need | File |
|---|---|
| **Primary logo** | **`logo.svg`** — mark + `edgify` wordmark, ink `#111111` |
| **Favicon** | **`favicon.ico`** (plus `favicon.svg` for modern browsers) |
| **Logo mark** | **`logo-mark.svg`** — the symbol alone, no wordmark |

---

## What the logo is

A triangle of three nodes — the knowledge-graph glyph — beside the lowercase wordmark
`edgify`.

- **Mark geometry** (unchanged, in the original 24-unit box): nodes at `(12, 5.5)`,
  `(5.5, 17.5)`, `(18.5, 17.5)`; three connecting lines at `stroke-width: 1.6` with round
  caps; node radius `2.7`.
- **Wordmark:** `edgify`, Inter 600, `letter-spacing: -0.4px` — the face the app already
  self-hosts via `next/font`. Converted to outline paths, so the SVGs need no font
  installed and render identically everywhere.
- **Palette** — only colours that already exist in the prototype:
  `#111111` ink · `#ffffff` · `#60a5fa` accent · `#0a0a0a` landing background.

### Two colour treatments, both original

The prototype uses the logo two ways, and both are shipped:

| | Treatment | Prototype source |
|---|---|---|
| `logo.svg`, `logo-mark.svg` | all `#111111` | app top bar (`.brand`) |
| `logo-dark.svg`, `logo-mark-dark.svg` | white, **third node `#60a5fa`** | landing nav (`.lx-brand`) |

The blue accent node exists only in the dark/marketing treatment — that is how the
prototype draws it, so it has not been added to or removed from either version. The two
lockups also carry their own original proportions (top bar: 22px mark / 9px gap / 17px
type; landing: 22px mark / 10px gap / 18px type).

---

## Files

### Logo

| File | Size | Use |
|---|---|---|
| `logo.svg` | vector, 78.46 × 18.29 | **Primary.** Header, docs, anywhere on a light background |
| `logo.png` | 2400 × 559, transparent | Raster fallback, email, slides, README badges |
| `logo-dark.svg` | vector, 82.52 × 18.87 | Dark backgrounds — the landing/marketing lockup |
| `logo-dark.png` | 2400 × 549, transparent | Raster fallback for dark backgrounds |

### Mark only

| File | Size | Use |
|---|---|---|
| `logo-mark.svg` | vector, 18.4 × 17.4 | Where the wordmark will not fit — avatars, compact nav, loaders |
| `logo-mark.png` | 1104 × 1044, transparent | Raster fallback (exact 92 : 87 ratio) |
| `logo-mark-dark.svg` / `.png` | same | Dark-background variants |

All four are cropped tight to the artwork, so padding is yours to control.

### Icons

| File | Size | Use |
|---|---|---|
| `favicon.ico` | 16 + 32 + 48 | Browser tab, bookmarks, legacy |
| `favicon.svg` | vector | Browser tab, modern browsers — scales to any DPI |
| `favicon-16x16.png` | 16 × 16 | Browser tab |
| `favicon-32x32.png` | 32 × 32 | Browser tab, taskbar, desktop shortcut |
| `apple-touch-icon.png` | 180 × 180 | iOS / Safari home screen |
| `icon-192.png` | 192 × 192 | PWA, Android launcher |
| `icon-512.png` | 512 × 512 | PWA splash, store listing |
| `og-image.png` | 1200 × 630 | Social / share preview |

Icons use the landing-page treatment — the white mark with the blue node on the `#0a0a0a`
landing background — because a `#111111` mark on transparency disappears against a dark
browser tab bar, and iOS composites transparency onto black. They are deliberately
**opaque**, with no alpha channel.

The wordmark is dropped from every icon: `edgify` is unreadable below about 100px wide, so
the icons carry the mark only, exactly as the brief requires. No new symbol was invented.

---

## Wired into the app

These are **installed**, not just available. This folder stays the source of truth; the
copies below are what Next.js actually serves.

| Installed at | From | Serves |
|---|---|---|
| `app/favicon.ico` | `favicon.ico` | `/favicon.ico` — replaced the Next.js default |
| `app/icon.svg` | `favicon.svg` | `/icon.svg` |
| `app/apple-icon.png` | `apple-touch-icon.png` | `/apple-icon.png` |
| `public/icon-192.png` | `icon-192.png` | `/icon-192.png` |
| `public/icon-512.png` | `icon-512.png` | `/icon-512.png` |
| `public/og-image.png` | `og-image.png` | `/og-image.png` |

`app/favicon.ico`, `app/icon.svg` and `app/apple-icon.png` use Next's **file conventions** —
Next emits the `<link>` tags itself. `app/layout.tsx` therefore does *not* declare
`metadata.icons`: doing so would override the file convention rather than add to it.

`app/manifest.ts` supplies the PWA manifest at `/manifest.webmanifest`, and `app/layout.tsx`
carries `metadataBase`, `openGraph` and `twitter` for the share card.

Re-run after changing anything here:

```bash
cp edgify-logo-assets/favicon.ico          app/favicon.ico
cp edgify-logo-assets/favicon.svg          app/icon.svg
cp edgify-logo-assets/apple-touch-icon.png app/apple-icon.png
cp edgify-logo-assets/icon-192.png         public/icon-192.png
cp edgify-logo-assets/icon-512.png         public/icon-512.png
cp edgify-logo-assets/og-image.png         public/og-image.png
```

`favicon-16x16.png` and `favicon-32x32.png` are not installed separately — those two sizes
are already inside `favicon.ico`, and `icon.svg` covers every modern browser at any DPI.
They ship here for contexts outside the app that ask for loose PNGs.

### Apple and PWA notes

`apple-touch-icon.png` is 180 × 180 and opaque, per Apple's guidance — iOS applies its own
rounded-corner mask, so the file is a full square with the mark inside a ~19% margin that
clears it.

`icon-192.png` and `icon-512.png` keep all artwork inside the central 40%-radius circle, so
`app/manifest.ts` declares 512 as `maskable` as well as `any`.

### One caveat on the share card

`metadataBase` reads `BETTER_AUTH_URL` when the layout module is evaluated. A statically
prerendered page bakes in whatever that was at **build** time, and the Dockerfile builds with
the placeholder `http://localhost:3000`. Pass the real origin at image-build time if the
share card must resolve correctly for a Docker-built deployment. The favicon and app icons
are unaffected — they are plain paths and need no base URL.

---

## Do not replace the in-app logo with these files

The app draws the logo as **inline SVG** in `components/top-bar.tsx`,
`app/(marketing)/page.tsx` and the empty states. That is correct and should stay: inline
SVG inherits `currentColor`, costs no extra request, and needs no hydration. These assets
are for the places an inline component cannot reach — the browser tab, the OS home screen,
the share card, and anything outside the app.

---

## How these were produced, and how they were checked

Generated from the prototype, not traced or redrawn:

1. Mark coordinates copied verbatim from the prototype's inline SVG.
2. Wordmark shaped with HarfBuzz from the same Inter the app self-hosts, instanced at
   weight 600, and converted to outline paths.
3. Lockup metrics (22px mark, 9/10px gap, 17/18px type) taken from the prototype's own CSS
   and confirmed by measuring a real Chromium render.
4. Every PNG rendered from the vector at its native size — the 16px favicon is its own
   render, never a downscale of a larger bitmap.
5. `favicon.ico` assembled from three independent renders as 32-bit BMP entries.

Verified against a live Chromium render of the prototype markup at 16× zoom:

| | ink size vs prototype | mean pixel difference |
|---|---|---|
| `logo.svg` | −0.06 × 0.00 px | 0.43 / 255 |
| `logo-dark.svg` | −0.06 × −0.06 px | 0.65 / 255 |

Differences are antialiasing only — under one device pixel in ~1320.

Also checked: SVGs parse and carry no embedded raster, editor metadata or script; the
palette contains no colour outside the four above; PNG dimensions and aspect ratios match
their vectors to within 0.06%; transparency is present where intended and absent on the
icon tiles; tight-cropped assets touch all four edges with no clipping and no wasted
margin; icon marks are centred and clear their safe areas; and `favicon.ico` re-parses with
all three entries intact.

### One deliberate departure

Chromium reports the wordmark baseline 0.93px higher than the font metrics specify, at the
top bar's 17px size only. Rendering the same lockup scaled up shows this is integer
rounding of font metrics at small sizes, not the design — it converges on the true
typographic value, `(ascender − descender) / 2`. The vector assets use the true value, so
they stay correct at every size rather than baking in a 17px rasteriser artifact.
