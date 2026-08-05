import { MICROS_PER_USD } from "@/lib/db/queries/usage-admin";
import type {
  DailySpendRow,
  ModelUsageRow,
  OutcomeBreakdownRow,
  QuotaTodayRow,
  TierBreakdownRow,
  UserUsageRow,
} from "@/lib/db/queries/usage-admin";

/**
 * The internal usage dashboard's presentation (docs/06 Phase 7).
 *
 * A Server Component: it holds no state and takes no interaction, so shipping it to the browser
 * would buy nothing. It is also the only consumer of the fleet-wide aggregates, which are
 * authorised at the page above (`lib/admin.ts`) and nowhere else.
 *
 * NO CHARTING LIBRARY. The bars are CSS widths. AGENTS.md is explicit that adding a dependency the
 * spec does not ask for is a regression, and a bar whose length is a percentage does not need one.
 *
 * DELIBERATELY PLAIN, and not a port of the prototype. Rule 6 ("the prototype is the visual
 * specification") governs the product surface — this page is not in the prototype and has no user
 * to design for. Making it look like the app would invite the next person to treat it as a
 * product surface, which is the opposite of what it is.
 */

type Props = {
  windowDays: number;
  users: UserUsageRow[];
  tiers: TierBreakdownRow[];
  outcomes: OutcomeBreakdownRow[];
  daily: DailySpendRow[];
  models: ModelUsageRow[];
  quotaToday: QuotaTodayRow[];
  quotaLimit: number;
};

/**
 * docs/09 §6 sets ONE alert before launch: demo-tier rate above 5% in an hour. docs/08's weekly
 * ritual uses 2% as the healthy ceiling. Both are shown, because they answer different questions —
 * "is something broken right now" and "is this drifting".
 */
const DEMO_RATE_ALERT = 0.05;
const DEMO_RATE_HEALTHY = 0.02;
/** docs/08: 30%+ once a class starts sharing documents. */
const CACHE_RATE_TARGET = 0.3;

const usd = (micros: number) => `$${(micros / MICROS_PER_USD).toFixed(4)}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export function UsageDashboard({
  windowDays,
  users,
  tiers,
  outcomes,
  daily,
  models,
  quotaToday,
  quotaLimit,
}: Props) {
  const rowsByTier = new Map(tiers.map((t) => [t.tier ?? "unknown", t.rows]));
  const totalRows = tiers.reduce((n, t) => n + t.rows, 0);
  const cacheRows = rowsByTier.get("cache") ?? 0;
  const demoRows = rowsByTier.get("demo") ?? 0;

  // Guard every rate against a zero denominator. An empty ledger is the NORMAL state before
  // launch, and NaN% rendered across a fresh dashboard reads as "broken" rather than "no data".
  const cacheRate = totalRows > 0 ? cacheRows / totalRows : 0;
  const demoRate = totalRows > 0 ? demoRows / totalRows : 0;

  const totalCost = users.reduce((n, u) => n + u.costMicros, 0);
  const unpricedRows = users.reduce((n, u) => n + u.unpricedRows, 0);
  const totalGenerations = users.reduce((n, u) => n + u.generations, 0);
  const quotaByUser = new Map(quotaToday.map((q) => [q.userId, q.generations]));
  const peakDailyCost = Math.max(1, ...daily.map((d) => d.costMicros));

  return (
    <main className="mx-auto max-w-6xl px-6 py-10 font-sans text-sm text-neutral-800">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Usage &amp; spend</h1>
        <p className="mt-1 text-neutral-500">
          Internal view · last {windowDays} days · {totalRows.toLocaleString()} ledger rows
        </p>
      </header>

      {/*
        The unpriced warning sits ABOVE the totals on purpose. If this build cannot price a model,
        every cost figure below it is an UNDER-count, and a caveat printed underneath a number
        people have already read is a caveat nobody reads.
      */}
      {unpricedRows > 0 && (
        <p
          role="status"
          className="mb-6 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900"
        >
          <strong>{unpricedRows.toLocaleString()} rows have no price.</strong> Their spend is
          missing from every total on this page — real cost is higher than shown. Add the model ids
          listed under “By model” to <code>lib/ai/pricing.ts</code>.
        </p>
      )}

      <section className="mb-10 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Spend" value={usd(totalCost)} note={`${windowDays}d, priced rows only`} />
        <Stat label="Generations" value={totalGenerations.toLocaleString()} note="free + paid" />
        <Stat
          label="Cache hit rate"
          value={pct(cacheRate)}
          note={cacheRate >= CACHE_RATE_TARGET ? "at target (30%+)" : "below 30% target"}
          tone={cacheRate >= CACHE_RATE_TARGET ? "good" : "neutral"}
        />
        <Stat
          label="Demo-tier rate"
          value={pct(demoRate)}
          note={
            demoRate > DEMO_RATE_ALERT
              ? "ABOVE 5% — upstream may be broken"
              : demoRate > DEMO_RATE_HEALTHY
                ? "above the 2% weekly ceiling"
                : "healthy (under 2%)"
          }
          tone={demoRate > DEMO_RATE_ALERT ? "bad" : demoRate > DEMO_RATE_HEALTHY ? "warn" : "good"}
        />
      </section>

      <Panel
        title="Spend per day"
        subtitle="A step change here is what a runaway looks like hours before the billing cap reacts"
      >
        {daily.length === 0 ? (
          <Empty />
        ) : (
          <ol className="space-y-1">
            {daily.map((d) => (
              <li key={d.day} className="flex items-center gap-3">
                <span className="w-24 shrink-0 tabular-nums text-neutral-500">{d.day}</span>
                <span className="h-3 flex-1 overflow-hidden rounded-sm bg-neutral-100">
                  <span
                    className="block h-full rounded-sm bg-neutral-800"
                    style={{ width: `${(d.costMicros / peakDailyCost) * 100}%` }}
                  />
                </span>
                <span className="w-24 shrink-0 text-right tabular-nums">{usd(d.costMicros)}</span>
                <span className="w-28 shrink-0 text-right tabular-nums text-neutral-500">
                  {d.generations} gen
                  {d.unpricedRows > 0 && (
                    <span className="text-amber-700"> · {d.unpricedRows} unpriced</span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Panel>

      <Panel title="Per user" subtitle="Spend, tokens, and today's quota consumption">
        {users.length === 0 ? (
          <Empty />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <Th>User</Th>
                  <Th align="right">Generations</Th>
                  <Th align="right">Tokens in</Th>
                  <Th align="right">Tokens out</Th>
                  <Th align="right">Spend</Th>
                  <Th align="right">Quota today</Th>
                  <Th align="right">Last active</Th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const used = quotaByUser.get(u.userId) ?? 0;
                  const atLimit = used >= quotaLimit;
                  return (
                    <tr key={u.userId} className="border-b border-neutral-100">
                      <Td>
                        <span className="font-medium">{u.email ?? u.userId}</span>
                        {u.unpricedRows > 0 && (
                          <span className="ml-2 text-xs text-amber-700">
                            {u.unpricedRows} unpriced
                          </span>
                        )}
                      </Td>
                      <Td align="right">{u.generations.toLocaleString()}</Td>
                      <Td align="right">{u.tokensIn.toLocaleString()}</Td>
                      <Td align="right">{u.tokensOut.toLocaleString()}</Td>
                      <Td align="right">{usd(u.costMicros)}</Td>
                      <Td align="right">
                        <span className={atLimit ? "font-semibold text-red-700" : undefined}>
                          {used}/{quotaLimit}
                        </span>
                      </Td>
                      <Td align="right" className="text-neutral-500">
                        {u.lastActiveAt ? new Date(u.lastActiveAt).toISOString().slice(0, 16).replace("T", " ") : "—"}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="grid gap-6 md:grid-cols-2">
        <Panel title="By tier" subtitle="cache and demo are the two that matter">
          <Breakdown rows={tiers.map((t) => ({ label: t.tier ?? "unknown", n: t.rows }))} total={totalRows} />
        </Panel>
        <Panel title="By outcome" subtitle="failed and demo should both stay near zero">
          <Breakdown
            rows={outcomes.map((o) => ({ label: o.outcome ?? "unknown", n: o.rows }))}
            total={outcomes.reduce((n, o) => n + o.rows, 0)}
          />
        </Panel>
      </div>

      <Panel title="By model" subtitle="Unpriced ids are real spend missing from the totals above">
        {models.length === 0 ? (
          <Empty />
        ) : (
          <ul className="space-y-1">
            {models.map((m) => (
              <li key={m.modelId ?? "unknown"} className="flex items-center gap-3">
                <span className="flex-1 truncate font-mono text-xs">{m.modelId ?? "unknown"}</span>
                <span className="tabular-nums text-neutral-500">{m.rows} calls</span>
                <span className="w-24 text-right tabular-nums">
                  {m.priced ? (
                    usd(m.costMicros)
                  ) : (
                    <span className="font-medium text-amber-700">unpriced</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </main>
  );
}

function Stat({
  label,
  value,
  note,
  tone = "neutral",
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "neutral" | "good" | "warn" | "bad";
}) {
  const toneClass = {
    neutral: "text-neutral-500",
    good: "text-emerald-700",
    warn: "text-amber-700",
    bad: "text-red-700",
  }[tone];
  return (
    <div className="rounded-lg border border-neutral-200 px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {note && <div className={`mt-1 text-xs ${toneClass}`}>{note}</div>}
    </div>
  );
}

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8 rounded-lg border border-neutral-200 p-5">
      <h2 className="text-base font-semibold">{title}</h2>
      {subtitle && <p className="mb-4 mt-0.5 text-xs text-neutral-500">{subtitle}</p>}
      {children}
    </section>
  );
}

function Breakdown({ rows, total }: { rows: { label: string; n: number }[]; total: number }) {
  if (rows.length === 0) return <Empty />;
  return (
    <ul className="space-y-1">
      {rows
        .slice()
        .sort((a, b) => b.n - a.n)
        .map((r) => (
          <li key={r.label} className="flex items-center gap-3">
            <span className="w-20 shrink-0 text-neutral-600">{r.label}</span>
            <span className="h-3 flex-1 overflow-hidden rounded-sm bg-neutral-100">
              <span
                className="block h-full rounded-sm bg-neutral-400"
                style={{ width: total > 0 ? `${(r.n / total) * 100}%` : "0%" }}
              />
            </span>
            <span className="w-24 shrink-0 text-right tabular-nums text-neutral-500">
              {r.n} · {total > 0 ? pct(r.n / total) : "—"}
            </span>
          </li>
        ))}
    </ul>
  );
}

/**
 * An empty ledger is the expected state before launch, so it gets a real message. "No data" with
 * no explanation is indistinguishable from a broken query, and this page exists precisely to be
 * trusted about whether something is wrong.
 */
function Empty() {
  return <p className="text-neutral-500">No ledger rows in this window yet.</p>;
}

function Th({ children, align }: { children: React.ReactNode; align?: "right" }) {
  return <th className={`py-2 pr-4 font-medium ${align === "right" ? "text-right" : ""}`}>{children}</th>;
}

function Td({
  children,
  align,
  className = "",
}: {
  children: React.ReactNode;
  align?: "right";
  className?: string;
}) {
  return (
    <td className={`py-2 pr-4 tabular-nums ${align === "right" ? "text-right" : ""} ${className}`}>
      {children}
    </td>
  );
}
