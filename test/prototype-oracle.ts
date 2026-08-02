import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The prototype's OWN readiness JavaScript, extracted from
 * `docs/reference/edgify-prototype.html` and executed as a test oracle.
 *
 * AGENTS.md rule 6 makes the prototype the specification, and the usual way that is honoured —
 * porting the algorithm and hand-writing the expected numbers — has a hole in it: the expectations
 * are written by whoever wrote the port, from the same reading, so a misreading is copied into
 * both and the test agrees with the bug. That is exactly what happened to the docs, where
 * "weight each prerequisite by 1 / depth" quietly lost the transitive closure.
 *
 * So instead of trusting a reading, this runs the reference. `lib/graph/readiness.ts` is compared
 * against it across the curated graph and randomised mastery assignments, and any divergence
 * fails with both numbers.
 *
 * The extraction is deliberately brittle: it locates a contiguous, named block and throws if the
 * shape is not found. A prototype edit that moves these functions should fail loudly here rather
 * than silently leave the oracle testing nothing.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PROTOTYPE = resolve(here, "../docs/reference/edgify-prototype.html");

/** `C` as the prototype holds it: slug → { name, pre, min, ... }. */
export type PrototypeConcept = {
  name: string;
  pre: string[];
  min: number;
};

export type PrototypeOracle = {
  mval: (m: string | undefined) => number;
  closure: (id: string) => Record<string, number>;
  readiness: (id: string) => number;
  layerOf: (id: string, seen?: Set<string>) => number;
  fmtTime: (m: number) => string;
  normDiff: (d: string) => string;
  diffMin: (d: string) => number;
};

/**
 * Pull the block from `const mval=` down to the end of `function diffMin(...)`. In the reference
 * this is one contiguous region (proto:1046–1056) holding every function under test.
 */
function extractAlgorithmSource(): string {
  const html = readFileSync(PROTOTYPE, "utf8");
  const start = html.indexOf("const mval=");
  if (start === -1) {
    throw new Error(
      "prototype oracle: could not find `const mval=` in edgify-prototype.html — the readiness " +
        "block has moved or been renamed, and this oracle is no longer reading the reference",
    );
  }
  const diffMinAt = html.indexOf("function diffMin(", start);
  if (diffMinAt === -1) {
    throw new Error("prototype oracle: could not find `function diffMin(` after `const mval=`");
  }
  const end = html.indexOf("\n", diffMinAt);
  const source = html.slice(start, end);

  // Guard the premise: every function the oracle exposes must actually be in the slice.
  for (const name of ["closure", "readiness", "layerOf", "fmtTime", "normDiff", "diffMin"]) {
    if (!source.includes(`function ${name}(`)) {
      throw new Error(`prototype oracle: extracted block does not define ${name}()`);
    }
  }
  return source;
}

const ALGORITHM_SOURCE = extractAlgorithmSource();

/** Instantiate the reference implementation over a given graph and mastery map. */
export function prototypeOracle(
  concepts: Record<string, PrototypeConcept>,
  mastery: Record<string, string>,
): PrototypeOracle {
  const factory = new Function(
    "C",
    "mastery",
    `${ALGORITHM_SOURCE}
     return { mval, closure, readiness, layerOf, fmtTime, normDiff, diffMin };`,
  );
  return factory(concepts, mastery) as PrototypeOracle;
}

/** The prototype's `CURATED` graph, reduced to what the algorithm reads. Kept beside the oracle. */
export function curatedPrototypeGraph(): Record<string, PrototypeConcept> {
  const html = readFileSync(PROTOTYPE, "utf8");
  const concepts: Record<string, PrototypeConcept> = {};
  // Each curated entry opens `slug:{name:"…", x:…, y:…, diff:"…", pre:[…], rel:[…], min:…,`
  const entry =
    /(\w+):\{name:"([^"]+)",\s*x:\s*-?\d+,\s*y:\s*-?\d+,\s*diff:"([^"]+)",\s*pre:\[([^\]]*)\],\s*rel:\[[^\]]*\],\s*min:(\d+)/g;
  for (const match of html.matchAll(entry)) {
    const [, slug, name, , pre, min] = match;
    concepts[slug] = {
      name,
      pre: pre
        .split(",")
        .map((s) => s.trim().replace(/^"|"$/g, ""))
        .filter((s) => s.length > 0),
      min: Number(min),
    };
  }
  if (Object.keys(concepts).length < 10) {
    throw new Error(
      `prototype oracle: parsed only ${Object.keys(concepts).length} curated concepts; the ` +
        "CURATED literal has changed shape",
    );
  }
  return concepts;
}

/** The prototype's initial mastery state (proto:1043). */
export const PROTOTYPE_INITIAL_MASTERY: Record<string, string> = {
  calc: "known",
  linalg: "known",
  opt: "learning",
  prob: "locked",
  gd: "locked",
  bp: "locked",
  nn: "locked",
  cnn: "locked",
  rnn: "locked",
  attn: "locked",
};

export { PROTOTYPE as PROTOTYPE_PATH, join };
