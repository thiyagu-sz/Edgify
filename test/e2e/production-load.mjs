const BASE =
  process.env.APP_BASE ??
  "https://edgify-3s236wlaja-el.a.run.app";

const USERS = Number(process.env.USERS ?? 25);
const DURATION_MS = Number(process.env.DURATION_MS ?? 60_000);
const REQUEST_GAP_MS = Number(process.env.REQUEST_GAP_MS ?? 1000);

const results = [];
const started = Date.now();

async function worker(id) {
  while (Date.now() - started < DURATION_MS) {
    const t0 = performance.now();

    try {
      const response = await fetch(`${BASE}/api/health`, {
        method: "GET",
        redirect: "manual",
      });

      const latencyMs = Math.round(performance.now() - t0);

      results.push({
        user: id,
        status: response.status,
        latencyMs,
      });

      if (response.status >= 500) {
        console.error(`STOP: worker ${id} received HTTP ${response.status}`);
        process.exitCode = 2;
        return;
      }
    } catch (err) {
      const latencyMs = Math.round(performance.now() - t0);

      results.push({
        user: id,
        status: "network-error",
        latencyMs,
        error: String(err),
      });

      console.error(`STOP: worker ${id} network error: ${err}`);
      process.exitCode = 2;
      return;
    }

    await new Promise((r) => setTimeout(r, REQUEST_GAP_MS));
  }
}

console.log(`Target: ${BASE}/api/health`);
console.log(`Concurrent users: ${USERS}`);
console.log(`Duration: ${DURATION_MS}ms`);
console.log(`Request gap: ${REQUEST_GAP_MS}ms`);
console.log("");

await Promise.all(
  Array.from({ length: USERS }, (_, i) => worker(i + 1)),
);

const elapsed = Date.now() - started;

const counts = {};
for (const r of results) {
  counts[r.status] = (counts[r.status] ?? 0) + 1;
}

const latencies = results
  .filter((r) => typeof r.latencyMs === "number")
  .map((r) => r.latencyMs)
  .sort((a, b) => a - b);

const percentile = (p) => {
  if (!latencies.length) return null;
  const index = Math.min(
    latencies.length - 1,
    Math.ceil((p / 100) * latencies.length) - 1,
  );
  return latencies[index];
};

const fiveXX = results.filter(
  (r) => typeof r.status === "number" && r.status >= 500,
).length;

console.log("=== PRODUCTION LOAD CONTROL ===");
console.log(`Elapsed: ${elapsed}ms`);
console.log(`Requests: ${results.length}`);
console.log(`Statuses: ${JSON.stringify(counts)}`);
console.log(`p50 latency: ${percentile(50)}ms`);
console.log(`p95 latency: ${percentile(95)}ms`);
console.log(`p99 latency: ${percentile(99)}ms`);
console.log(`5xx responses: ${fiveXX}`);

if (fiveXX > 0 || process.exitCode === 2) {
  console.log("RESULT: FAIL");
  process.exitCode = 2;
} else {
  console.log("RESULT: PASS");
}
