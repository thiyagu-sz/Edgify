---
paths:
  - "components/**"
  - "app/**/*.tsx"
---
# UI rules
docs/reference/trellis-prototype.html is the visual spec. Port it faithfully.
- Do not redesign or substitute a component library
- Sanitise model output before dangerouslySetInnerHTML
- Escape model-generated strings in SVG text and HTML attributes