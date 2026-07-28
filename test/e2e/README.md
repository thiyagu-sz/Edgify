# End-to-end proofs

Browser-driven checks for the acceptance criteria that unit and component tests cannot reach:
visual fidelity against the prototype, mutation-XSS in a real HTML parser, the degradation ladder
under genuine config failure, and live-model latency.

These are **not** part of `npm test`. They need a running server, a database and (for some) real
model credits, so they are run deliberately rather than in CI.

## Setup

```bash
# 1. Build and start the app you want to measure. Use a PRODUCTION build — the dev server's
#    overhead is large enough to distort latency figures.
npm run build && npm start

# 2. Mint a session (Google OAuth cannot be driven headlessly).
node --env-file=.env.local test/e2e/seed-session.mjs
# → prints { cookieName, cookieValue, userId, ... }

export SESSION_COOKIE='better-auth.session_token=<cookieValue>'
```

`seed-session.mjs` writes a normal `user` + `session` row and signs the cookie exactly as the
server does. There is **no auth bypass in the application** — the server validates this session
like any other; only Google's consent screen is skipped. The seeded user is userId-scoped like
everyone else. Clean up with `node --env-file=.env.local test/e2e/seed-session.mjs --cleanup`.

## The scripts

| Script | Proves | Costs tokens |
|---|---|---|
| `visual-diff.mjs` | Seven UI states are pixel-equivalent to the prototype at two viewports | no |
| `measure-geometry.mjs` | Diagnostic: attributes a pixel difference to a specific CSS rule | no |
| `browser-proofs.mjs` | mXSS corpus does not execute in Chromium; progressive rendering; first paint | a little |
| `degradation-proof.mjs` | Model failure → calm sample notes + visible banner, never a hung spinner | no |
| `first-token-latency.mjs` | First-token distribution, attributed between database and provider | yes, n×1 |
| `all-formats.mjs` | All eight formats return usable output | yes, 8 |

```bash
node --env-file=.env.local test/e2e/visual-diff.mjs
node --env-file=.env.local test/e2e/browser-proofs.mjs
N=10 node --env-file=.env.local test/e2e/first-token-latency.mjs
node --env-file=.env.local test/e2e/all-formats.mjs
```

### Degradation runs

Each mode needs the server started with a *genuinely* broken config — that is the point, so
resist the urge to stub a route instead.

```bash
# Every tier unreachable → demo content + banner
OPENROUTER_FREE_MODEL="nonexistent/nope:free" \
OPENROUTER_FREE_FALLBACKS="also-nonexistent/nope:free" \
OPENROUTER_PAID_MODEL="nonexistent/nope" npm start
MODE=demo node test/e2e/degradation-proof.mjs

# Bad key → 401, non-retryable, straight to demo, operator alert logged
OPENROUTER_API_KEY="sk-or-v1-0000…" npm start
MODE=badkey node test/e2e/degradation-proof.mjs
# Check the server log: expect one "model call: non-retryable error" with status 401 per model,
# and NO unhandledRejection. Both were real bugs found this way.

# Quota exhausted → friendly banner over a worked example
QUOTA_DAILY_LIMIT=1 npm start
# spend the one generation, then:
MODE=quota node test/e2e/degradation-proof.mjs
```

## Reading the visual diff

Output lands in `.artifacts/visual-diff/<viewport>/`, three PNGs per state (prototype, app,
diff) plus `results.json`. The percentage is the share of differing pixels, reported rather than
thresholded — anti-aliasing makes an exact zero unreachable, and a pass line tuned to go green
proves nothing. Every run prints the known, deliberate deviations; if a residual diff is not
explained by one of them, investigate rather than adjust the threshold.

When a state regresses, run `measure-geometry.mjs` first. It dumps element geometry and computed
typography from both sides and prints only what differs, which turns "the layout looks off" into
a named CSS property.
