import { describe, expect, it } from "vitest";
import { GET } from "./route";

/**
 * The real unauthenticated route, wired end to end: it reflects genuine DB status (not a
 * hardcoded "ok") and is wrapped by the rate limiter. The burst-rejection behaviour of that
 * wrapper is proven in lib/rate-limit.integration.test.ts.
 */
describe("GET /api/health", () => {
  it("returns ok and real DB status against a live database", async () => {
    const res = await GET(
      new Request("http://localhost/api/health", {
        headers: { "x-forwarded-for": "5.5.5.5" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", db: true });
  });
});
