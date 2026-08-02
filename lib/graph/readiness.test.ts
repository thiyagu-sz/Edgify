import { describe, expect, it } from "vitest";
import {
  PROTOTYPE_INITIAL_MASTERY,
  curatedPrototypeGraph,
  prototypeOracle,
  type PrototypeConcept,
} from "@/test/prototype-oracle";
import {
  closure,
  formatMinutes,
  layerOf,
  masteryValue,
  normaliseDifficulty,
  prerequisiteMap,
  readiness,
  relatedTo,
  studyPlan,
  type GraphConcept,
  type GraphEdge,
  type MasteryState,
} from "./readiness";

/**
 * Readiness is pinned against the PROTOTYPE'S OWN JavaScript, extracted from the reference HTML
 * and executed (test/prototype-oracle.ts) — not against hand-written expectations, which would
 * have been written from the same reading as the port and would agree with a misreading.
 *
 * That is not hypothetical here. docs/05 W6 said "weight each prerequisite by 1 / depth", which
 * reads as direct prerequisites only; the reference walks the full transitive closure and weights
 * every ancestor by 1/depth. The two produce different numbers on any graph deeper than one
 * layer, and the worked example below is the difference made concrete.
 */

const CURATED = curatedPrototypeGraph();

/** The curated graph in this module's shape. */
function asConcepts(graph: Record<string, PrototypeConcept>): GraphConcept[] {
  return Object.entries(graph).map(([slug, c]) => ({
    slug,
    name: c.name,
    difficulty: "Intermediate",
    summary: "",
    estimatedMinutes: c.min,
  }));
}

function asEdges(graph: Record<string, PrototypeConcept>): GraphEdge[] {
  return Object.entries(graph).flatMap(([slug, c]) =>
    c.pre.map((p) => ({ prerequisite: p, dependent: slug })),
  );
}

const CONCEPTS = asConcepts(CURATED);
const EDGES = asEdges(CURATED);
const PREREQS = prerequisiteMap(CONCEPTS, EDGES);

function masteryMap(record: Record<string, string>): Map<string, MasteryState> {
  return new Map(Object.entries(record) as [string, MasteryState][]);
}

describe("the oracle itself", () => {
  it("parsed the reference graph", () => {
    // Guards the premise: if the extraction silently returned nothing, every comparison below
    // would pass by comparing two empty things.
    expect(Object.keys(CURATED).length).toBe(10);
    expect(CURATED.cnn.pre).toEqual(["nn", "bp"]);
    expect(EDGES.length).toBeGreaterThan(10);
  });

  it("runs the reference implementation", () => {
    const oracle = prototypeOracle(CURATED, PROTOTYPE_INITIAL_MASTERY);
    expect(typeof oracle.readiness("cnn")).toBe("number");
  });
});

describe("readiness matches the prototype on the curated graph", () => {
  const oracle = prototypeOracle(CURATED, PROTOTYPE_INITIAL_MASTERY);
  const mastery = masteryMap(PROTOTYPE_INITIAL_MASTERY);

  for (const slug of Object.keys(CURATED)) {
    it(`readiness(${slug})`, () => {
      expect(readiness(slug, PREREQS, mastery)).toBe(oracle.readiness(slug));
    });

    it(`closure(${slug})`, () => {
      expect(Object.fromEntries(closure(slug, PREREQS))).toEqual(oracle.closure(slug));
    });

    it(`layerOf(${slug})`, () => {
      expect(layerOf(slug, PREREQS)).toBe(oracle.layerOf(slug));
    });
  }
});

/**
 * THE WORKED EXAMPLE — the one the doc correction turns on.
 *
 * `cnn` depends on `nn` and `bp`; `nn` on `linalg` and `bp`; `bp` on `gd` and `linalg`; `gd` on
 * `opt` and `calc`; `opt` on `calc` and `linalg`. So the closure of `cnn` is SEVEN concepts at
 * these shortest depths, not the two direct ones:
 *
 *     nn 1, bp 1, linalg 2, gd 2, opt 3, calc 3
 *
 * With the prototype's initial state (calc known, linalg known, opt learning, rest locked):
 *
 *     Σ weight          = 1/1 + 1/1 + 1/2 + 1/2 + 1/3 + 1/3        = 3.6667
 *     Σ weight × mastery= 0   + 0   + 1/2 + 0   + 1/3×0.5 + 1/3×1  = 1.0000
 *     readiness         = round(100 × 1.0 / 3.6667)                = 27
 *
 * Weighting only the DIRECT prerequisites — the doc's old paraphrase — gives
 * (nn 0 + bp 0) / 2 = 0, a different answer on the same data. That is why the paraphrase was
 * corrected rather than left as a harmless simplification.
 *
 * A note on how this number was arrived at, because it is the point of the whole file: it was
 * first written here as 25, from arithmetic done by hand while porting. The oracle disagreed and
 * the port was right. Hand-written expectations would have shipped the 25.
 */
describe("worked example — cnn on the curated graph", () => {
  const mastery = masteryMap(PROTOTYPE_INITIAL_MASTERY);

  it("has the seven-concept transitive closure, at shortest depths", () => {
    expect(Object.fromEntries(closure("cnn", PREREQS))).toEqual({
      nn: 1,
      bp: 1,
      linalg: 2,
      gd: 2,
      opt: 3,
      calc: 3,
    });
  });

  it("scores 27, and the prototype agrees", () => {
    expect(readiness("cnn", PREREQS, mastery)).toBe(27);
    expect(prototypeOracle(CURATED, PROTOTYPE_INITIAL_MASTERY).readiness("cnn")).toBe(27);
  });

  it("is NOT what direct-prerequisites-only scoring gives", () => {
    // The lossy paraphrase, implemented literally, for contrast.
    const direct = PREREQS.get("cnn") ?? [];
    const naive = Math.round(
      (100 * direct.reduce((n, p) => n + masteryValue(mastery.get(p)), 0)) / direct.length,
    );
    expect(naive).toBe(0);
    expect(naive).not.toBe(readiness("cnn", PREREQS, mastery));
  });
});

describe("readiness matches the prototype under randomised mastery", () => {
  const states: MasteryState[] = ["locked", "learning", "known"];
  const slugs = Object.keys(CURATED);

  // Deterministic PRNG so a failure is reproducible from the seed alone.
  function mulberry32(seed: number) {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  for (let seed = 1; seed <= 40; seed++) {
    it(`seed ${seed}`, () => {
      const rand = mulberry32(seed);
      const record: Record<string, string> = {};
      for (const slug of slugs) {
        record[slug] = states[Math.floor(rand() * states.length)];
      }
      const oracle = prototypeOracle(CURATED, record);
      const mastery = masteryMap(record);
      for (const slug of slugs) {
        expect(readiness(slug, PREREQS, mastery), `${slug} @ seed ${seed}`).toBe(
          oracle.readiness(slug),
        );
      }
    });
  }
});

describe("readiness edge cases", () => {
  it("is 100 for a concept with no prerequisites", () => {
    expect(readiness("calc", PREREQS, masteryMap({}))).toBe(100);
  });

  it("terminates on a cycle rather than hanging", () => {
    const concepts: GraphConcept[] = ["a", "b", "c"].map((slug) => ({
      slug,
      name: slug,
      difficulty: "Intermediate",
      summary: "",
      estimatedMinutes: 60,
    }));
    const edges: GraphEdge[] = [
      { prerequisite: "a", dependent: "b" },
      { prerequisite: "b", dependent: "c" },
      { prerequisite: "c", dependent: "a" },
    ];
    const prereqs = prerequisiteMap(concepts, edges);
    expect(readiness("a", prereqs, masteryMap({ b: "known" }))).toBeGreaterThanOrEqual(0);
    expect(layerOf("a", prereqs)).toBeGreaterThanOrEqual(0);
  });

  it("takes the SHORTEST depth when an ancestor is reachable two ways", () => {
    const concepts: GraphConcept[] = ["root", "mid", "leaf"].map((slug) => ({
      slug,
      name: slug,
      difficulty: "Intermediate",
      summary: "",
      estimatedMinutes: 60,
    }));
    const edges: GraphEdge[] = [
      { prerequisite: "root", dependent: "leaf" }, // depth 1
      { prerequisite: "root", dependent: "mid" },
      { prerequisite: "mid", dependent: "leaf" }, // root also reachable at depth 2
    ];
    const prereqs = prerequisiteMap(concepts, edges);
    expect(closure("leaf", prereqs).get("root")).toBe(1);
  });

  it("ignores edges naming a concept that is not in the set", () => {
    const concepts: GraphConcept[] = [
      { slug: "a", name: "a", difficulty: "Intermediate", summary: "", estimatedMinutes: 60 },
    ];
    const prereqs = prerequisiteMap(concepts, [{ prerequisite: "ghost", dependent: "a" }]);
    expect(prereqs.get("a")).toEqual([]);
  });
});

describe("helpers match the prototype", () => {
  const oracle = prototypeOracle(CURATED, PROTOTYPE_INITIAL_MASTERY);

  it("masteryValue", () => {
    expect(masteryValue("known")).toBe(oracle.mval("known"));
    expect(masteryValue("learning")).toBe(oracle.mval("learning"));
    expect(masteryValue("locked")).toBe(oracle.mval("locked"));
    expect(masteryValue(undefined)).toBe(oracle.mval(undefined));
  });

  it("formatMinutes", () => {
    for (const m of [0, 5, 45, 60, 90, 120, 150, 180, 200, 1439]) {
      expect(formatMinutes(m), `${m} minutes`).toBe(oracle.fmtTime(m));
    }
  });

  it("normaliseDifficulty", () => {
    for (const d of ["Foundational", "foundational", "ADVANCED", "adv", "Intermediate", "", "x"]) {
      expect(normaliseDifficulty(d), d).toBe(oracle.normDiff(d));
    }
    expect(normaliseDifficulty(null)).toBe("Intermediate");
  });
});

describe("relatedTo", () => {
  /**
   * This mirrors how the prototype DERIVES `rel` for a generated graph (`buildGraphFromDoc`,
   * proto:1248) — both directions, edge order, first four. It deliberately does not reproduce
   * `CURATED.nn.rel`, which is hand-authored sample data rather than something the algorithm
   * computes; comparing against that would be testing the fixture, not the port.
   */
  it("finds edges in either direction, capped at four", () => {
    expect(relatedTo("nn", EDGES)).toEqual(["linalg", "bp", "cnn", "rnn"]);
  });

  it("never includes the concept itself", () => {
    expect(relatedTo("calc", EDGES)).not.toContain("calc");
  });
});

describe("studyPlan", () => {
  const mastery = masteryMap(PROTOTYPE_INITIAL_MASTERY);

  it("orders deepest-first, then by name — the prototype's sort", () => {
    const plan = studyPlan("cnn", CONCEPTS, EDGES, mastery);
    const depth = closure("cnn", PREREQS);
    for (let i = 1; i < plan.steps.length; i++) {
      const prev = depth.get(plan.steps[i - 1].slug) ?? 0;
      const next = depth.get(plan.steps[i].slug) ?? 0;
      expect(prev).toBeGreaterThanOrEqual(next);
    }
  });

  it("counts covered prerequisites and the time left", () => {
    const plan = studyPlan("cnn", CONCEPTS, EDGES, mastery);
    expect(plan.total).toBe(6);
    // calc and linalg are `known` in the prototype's initial state.
    expect(plan.covered).toBe(2);
    expect(plan.steps.map((s) => s.slug).sort()).toEqual(["bp", "gd", "nn", "opt"]);
    expect(plan.minutesRemaining).toBe(
      ["bp", "gd", "nn", "opt"].reduce((n, s) => n + CURATED[s].min, 0),
    );
    expect(plan.readiness).toBe(27);
  });

  it("marks a step ready only when every direct prerequisite is known", () => {
    const plan = studyPlan("cnn", CONCEPTS, EDGES, mastery);
    // opt needs calc + linalg, both known → ready. bp needs gd (locked) → not ready.
    expect(plan.steps.find((s) => s.slug === "opt")?.ready).toBe(true);
    expect(plan.steps.find((s) => s.slug === "bp")?.ready).toBe(false);
  });

  it("is empty for a foundational concept", () => {
    const plan = studyPlan("calc", CONCEPTS, EDGES, mastery);
    expect(plan.total).toBe(0);
    expect(plan.steps).toEqual([]);
    expect(plan.readiness).toBe(100);
  });
});
