import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { applyTestEnvDefaults } from "./test-env";

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
 * The XSS sentinel (declared in test/xss-payloads.ts). Every injected payload tries to set
 * `window.__xss`; if it is ever defined after a render, script executed and the test fails.
 * Cleared around every test so one leak cannot mask another.
 */
beforeEach(() => {
  delete window.__xss;
});

afterEach(() => {
  cleanup();
  delete window.__xss;
});
