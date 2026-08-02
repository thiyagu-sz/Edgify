import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { applyTestEnvDefaults } from "./test-env";
import { resetXssSentinel } from "./xss-payloads";

/**
 * Per-worker setup for COMPONENT tests (jsdom, no database, no network).
 *
 * These prove the UI-side acceptance criteria that a node-environment test cannot reach: that
 * poisoned model output never executes in the DOM, that a malformed quiz degrades to a calm
 * state, that the quota counter reads as a budget rather than an error, and — the invariant that
 * matters most — that the spinner ALWAYS resolves (docs/06 Phase 4; .claude/rules/ui.md).
 *
 * `fetch` is deliberately left unstubbed here. Each test installs its own fake, so a component
 * that reaches the network without the test arranging it fails loudly instead of silently
 * hitting a real route.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/edgify_component";
applyTestEnvDefaults();

/**
 * The XSS sentinel (test/xss-payloads.ts). Every injected payload writes a marker; if it is set
 * after a render, script executed and the test fails. Cleared around every test so one leak
 * cannot mask another.
 *
 * The marker is written to `document.title`, NOT to `window.__xss` — measured 2026-07-31, a
 * payload's `window` write does not cross jsdom's realm boundary into the test, so the old
 * sentinel could never fire and every assertion on it passed vacuously. See the long note in
 * test/xss-payloads.ts.
 */
beforeEach(() => {
  resetXssSentinel();
});

afterEach(() => {
  cleanup();
  resetXssSentinel();
});
