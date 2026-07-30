---
paths:
  - "components/**/*.tsx"
  - "app/**/*.tsx"
  - "app/**/*.css"
---

# UI rules

## The prototype is the visual specification

`docs/reference/edgify-prototype.html` defines the design exactly: the dark
landing page, the light workspace, the two-feature switcher, the graph rendering,
the panel scroll behaviour.

- Port it faithfully. Do not redesign, do not "improve", do not substitute a
  component library's default styling
- The prototype's `:root` custom properties become the Tailwind theme
- Keep the prototype's inline SVG for the brand mark, graph nodes and readiness
  rings — they are already correct
- The landing page is dark and the workspace is light. Landing tokens must be
  scoped to `#landing` so they cannot leak into the workspace

## Rendered model output must not execute script

**This is the highest-severity UI bug in the project.** `marked` does not sanitise
HTML by default, and model output can be steered by text inside an uploaded
document.

- Sanitise all model output before `dangerouslySetInnerHTML`
- Escape model-generated strings used in SVG `<text>` and in HTML attributes —
  concept names, quiz options and graph node labels are model output too
- Escape filenames before rendering them as document titles

The realistic attack: someone shares a lecture PDF containing injected
instructions, a classmate uploads it, the model echoes the payload, and it runs in
the classmate's session. The shared dedupe cache can then serve it to anyone with
the same file.

## Never show a raw error

No stack traces, HTTP status codes, provider names, or `error.message`. Use the
message catalogue in `docs/04-resilience.md` §7.

Every user-facing message does three things: says what happened in plain language,
says whether their data is safe, and offers a next action.

## Quota is a product surface, not an error

- Under 80%: show nothing
- At 80%: quiet counter, "6 generations left today"
- At 100%: friendly state with reset time, offer demo mode

"You've used today's generations" is a fact about a budget. "Error: quota
exceeded" is a failure. Same information, completely different feeling.

## Demo mode is always labelled

Demo content is never a silent substitution. Passing off sample content as an
analysis of the user's own document is the one genuinely bad outcome available
here.

## Components

- Server Components by default; `"use client"` only for state, effects or browser APIs
- Export is client-side (`jsPDF`, Word-HTML blob), ported from the prototype
- Render the shell and a skeleton immediately rather than blocking on data — cold
  starts are far less noticeable during page load than mid-interaction
