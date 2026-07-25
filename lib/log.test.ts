import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

import * as Sentry from "@sentry/nextjs";
import { log } from "./log";

describe("log", () => {
  afterEach(() => vi.restoreAllMocks());

  it("writes one structured JSON line to stdout for info", () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    log.info("hello", { userId: "u1" });

    expect(write).toHaveBeenCalledOnce();
    const parsed = JSON.parse(write.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({ level: "info", message: "hello", userId: "u1" });
    expect(typeof parsed.time).toBe("string");
  });

  it("logs errors to stderr AND forwards them to Sentry with the original error", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const err = new Error("boom");

    log.error("failed thing", err, { operation: "x" });

    const parsed = JSON.parse(write.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({
      level: "error",
      message: "failed thing",
      operation: "x",
    });
    expect(parsed.error).toMatchObject({ name: "Error", message: "boom" });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({
        extra: expect.objectContaining({ message: "failed thing", operation: "x" }),
      }),
    );
  });

  it("synthesises an Error for Sentry when none is passed", () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    log.error("no error object");
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.anything(),
    );
  });
});
