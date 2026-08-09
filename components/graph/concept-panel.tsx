"use client";

import { useState } from "react";
import posthog from "posthog-js";
import {
  closure,
  formatMinutes,
  masteryValue,
  normaliseDifficulty,
  readiness,
  relatedTo,
  type GraphConcept,
  type GraphEdge,
  type MasteryState,
} from "@/lib/graph/readiness";
import { plainText, renderMarkdown } from "@/lib/sanitize";
import type { DetailState, GraphConceptView } from "./types";

/**
 * The concept panel — a faithful port of the prototype's `renderPanel` / `pHeader` / `chip` /
 * `ringSVG` (docs/reference/edgify-prototype.html).
 *
 * ── WHERE MODEL OUTPUT LANDS, AND WHAT ESCAPES IT ───────────────────────────────────────────
 *
 * Everything here except the section headings is model output. Three different mechanisms make it
 * safe, and they are not interchangeable:
 *
 *  1. TEXT CHILDREN (name, summary, quiz question and options, flashcards, chip labels) — React
 *     escapes these on output. `plainText()` is applied first, which only decodes the entities the
 *     storage seam introduced so `x < y` does not render as `x &lt; y`; React re-escapes.
 *  2. THE MARKDOWN BODY (definition, example) — goes through `renderMarkdown`, the allowlist
 *     sanitiser, before `dangerouslySetInnerHTML`. This is the only innerHTML in the file.
 *  3. ATTRIBUTES (`aria-label`, `key`) — React escapes attribute values too.
 *
 * Upstream of all three, `lib/ai/schemas` has already stripped markup at the validation seam, so
 * nothing dirty is ever stored or distributed. These are the second line, not the first.
 * `knowledge-graph.sanitize.test.tsx` proves each surface by rendering the prototype's own
 * unescaped string-concatenation template beside it and showing THAT one executes.
 */

export function ConceptPanel({
  concept,
  concepts,
  edges,
  mastery,
  detail,
  subTab,
  cardIndex,
  onSubTab,
  onSelect,
  onToggleMastered,
  analyticsEnabled,
  onQuizCorrect,
  onCardIndex,
  onOpenPlan,
}: {
  concept: GraphConceptView;
  concepts: GraphConcept[];
  edges: GraphEdge[];
  mastery: Map<string, MasteryState>;
  detail: DetailState | undefined;
  subTab: "overview" | "quiz" | "cards";
  cardIndex: number;
  onSubTab: (tab: "overview" | "quiz" | "cards") => void;
  onSelect: (slug: string) => void;
  onToggleMastered: () => void;
  analyticsEnabled: boolean;
  onQuizCorrect: () => void;
  onCardIndex: (index: number) => void;
  onOpenPlan: () => void;
}) {
  const state = mastery.get(concept.slug) ?? "locked";
  const summary = plainText(concept.summary ?? "");

  // The loading state keeps the header and the summary visible (prototype `renderPanel`, the
  // `c.loaded === false` branch): the user sees which concept they picked and something about it
  // immediately, rather than a bare spinner.
  if (detail?.kind === "loading") {
    return (
      <aside className="card panel">
        <PanelHeader concept={concept} state={state} />
        {summary && (
          <div className="p-section">
            <h4>In brief</h4>
            <div className="def">{summary}</div>
          </div>
        )}
        <div className="loading" style={{ minHeight: 180 }}>
          <div className="spin" />
          <p>Building a deep, document-grounded explanation of {plainText(concept.name)}…</p>
        </div>
      </aside>
    );
  }

  return (
    <aside className="card panel">
      <PanelHeader concept={concept} state={state} />
      <div className="pill-group mini" role="tablist" style={{ marginTop: 18 }}>
        {(["overview", "quiz", "cards"] as const).map((tab) => (
          <button
            key={tab}
            className="seg"
            role="tab"
            type="button"
            aria-selected={subTab === tab}
            onClick={() => onSubTab(tab)}
          >
            {tab === "overview" ? "Overview" : tab === "quiz" ? "Quiz" : "Cards"}
          </button>
        ))}
      </div>

      <div className="subpanel" hidden={subTab !== "overview"} style={{ marginTop: 4 }}>
        <Overview
          concept={concept}
          concepts={concepts}
          edges={edges}
          mastery={mastery}
          detail={detail}
          onSelect={onSelect}
          onToggleMastered={onToggleMastered}
          onOpenPlan={onOpenPlan}
        />
      </div>
      <div className="subpanel" hidden={subTab !== "quiz"} style={{ marginTop: 20 }}>
        <ConceptQuiz detail={detail} analyticsEnabled={analyticsEnabled} onCorrect={onQuizCorrect} />
      </div>
      <div className="subpanel" hidden={subTab !== "cards"} style={{ marginTop: 20 }}>
        <Flashcards detail={detail} cardIndex={cardIndex} onCardIndex={onCardIndex} />
      </div>
    </aside>
  );
}

function PanelHeader({
  concept,
  state,
}: {
  concept: GraphConceptView;
  state: MasteryState;
}) {
  const label = state === "known" ? "Mastered" : state === "learning" ? "In progress" : "Not started";
  const pip = state === "known" ? "pip-known" : state === "learning" ? "pip-learning" : "pip-locked";
  return (
    <div className="p-top">
      <div>
        <div className="p-title">{plainText(concept.name)}</div>
        <div className="status-line">
          <span className={`status-pip ${pip}`} />
          {label} · {formatMinutes(concept.estimatedMinutes ?? 0)} of focused study
        </div>
      </div>
      <span className="badge">{normaliseDifficulty(concept.difficulty)}</span>
    </div>
  );
}

function Overview({
  concept,
  concepts,
  edges,
  mastery,
  detail,
  onSelect,
  onToggleMastered,
  onOpenPlan,
}: {
  concept: GraphConceptView;
  concepts: GraphConcept[];
  edges: GraphEdge[];
  mastery: Map<string, MasteryState>;
  detail: DetailState | undefined;
  onSelect: (slug: string) => void;
  onToggleMastered: () => void;
  onOpenPlan: () => void;
}) {
  const prerequisites = prerequisitesOf(concepts, edges);
  const pct = readiness(concept.slug, prerequisites, mastery);
  const depth = closure(concept.slug, prerequisites);
  const depIds = [...depth.keys()];
  const byslug = new Map(concepts.map((c) => [c.slug, c]));

  const known = depIds.filter((id) => mastery.get(id) === "known");
  const missing = depIds
    .filter((id) => mastery.get(id) !== "known")
    .sort(
      (a, b) =>
        (depth.get(b) ?? 0) - (depth.get(a) ?? 0) ||
        (byslug.get(a)?.name ?? a).localeCompare(byslug.get(b)?.name ?? b),
    );
  const missingMinutes = missing.reduce((n, id) => n + (byslug.get(id)?.estimatedMinutes ?? 0), 0);
  const nextUp = missing.filter((id) =>
    (prerequisites.get(id) ?? []).every((p) => mastery.get(p) === "known"),
  );

  const ringSub =
    pct === 100
      ? "You've covered every prerequisite. Ready to go deep on this one."
      : `${known.length} of ${depIds.length} prerequisites covered · about ${formatMinutes(missingMinutes)} of groundwork left.`;

  const direct = prerequisites.get(concept.slug) ?? [];
  const related = relatedTo(concept.slug, edges);
  const state = mastery.get(concept.slug) ?? "locked";

  // W5: on ladder exhaustion the panel shows the concept's own summary — derived from the user's
  // document during the structure pass — plus the honest line. Never a demo detail (docs/05 W5).
  const body =
    detail?.kind === "ready"
      ? detail.detail.definition
      : (concept.summary ?? "");
  const example = detail?.kind === "ready" ? detail.detail.example : "";

  return (
    <>
      <div className="ring-wrap">
        <ReadinessRing pct={pct} radius={43} className="ring" />
        <div className="ring-info">
          <div className="rl">Learning readiness</div>
          <div className="rs">{ringSub}</div>
        </div>
      </div>

      <div className="p-section">
        <h4>Definition</h4>
        {/* Sanitised at the single chokepoint (lib/sanitize) before this innerHTML. */}
        <div className="def" dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }} />
        {detail?.kind === "unavailable" && (
          <p className="muted-note" style={{ marginTop: 12 }}>
            A detailed explanation couldn&apos;t be generated.
          </p>
        )}
        {example.trim() && (
          <div className="example" dangerouslySetInnerHTML={{ __html: renderMarkdown(example) }} />
        )}
      </div>

      {direct.length > 0 && (
        <div className="p-section">
          <h4>Direct prerequisites</h4>
          <div className="chips">
            {direct.map((slug) => (
              <Chip key={slug} slug={slug} concepts={byslug} mastery={mastery} onSelect={onSelect} />
            ))}
          </div>
        </div>
      )}

      {missing.length > 0 && (
        <div className="p-section">
          <h4>Learn next</h4>
          <div className="chips">
            {(nextUp.length > 0 ? nextUp : [missing[missing.length - 1]])
              .slice(0, 3)
              .map((slug) => (
                <Chip
                  key={slug}
                  slug={slug}
                  concepts={byslug}
                  mastery={mastery}
                  onSelect={onSelect}
                  next
                />
              ))}
          </div>
        </div>
      )}

      {related.length > 0 && (
        <div className="p-section">
          <h4>Related</h4>
          <div className="chips">
            {related.map((slug) => (
              <Chip key={slug} slug={slug} concepts={byslug} mastery={mastery} onSelect={onSelect} />
            ))}
          </div>
        </div>
      )}

      <div className="p-actions">
        <button
          className={state === "known" ? "btn-secondary" : "btn-primary"}
          type="button"
          onClick={onToggleMastered}
        >
          <IconCheck /> {state === "known" ? "Mastered" : "Mark as mastered"}
        </button>
        <button className="btn-secondary" type="button" onClick={onOpenPlan}>
          Study plan
        </button>
      </div>
    </>
  );
}

function Chip({
  slug,
  concepts,
  mastery,
  onSelect,
  next = false,
}: {
  slug: string;
  concepts: Map<string, GraphConcept>;
  mastery: Map<string, MasteryState>;
  onSelect: (slug: string) => void;
  next?: boolean;
}) {
  const concept = concepts.get(slug);
  if (!concept) return null;
  const state = mastery.get(slug) ?? "locked";
  const colour =
    state === "known"
      ? "var(--surface-dark)"
      : state === "learning"
        ? "var(--warning)"
        : "var(--surface-strong)";

  return (
    <button
      className={next ? "chip next" : "chip"}
      type="button"
      onClick={() => onSelect(slug)}
    >
      {/* The pip colour comes from a fixed three-value set above, never from model output. */}
      {!next && <span className="cpip" style={{ background: colour }} />}
      {plainText(concept.name)}
      {next && <IconArrow />}
    </button>
  );
}

/** The prototype's `ringSVG`. */
export function ReadinessRing({
  pct,
  radius,
  className,
}: {
  pct: number;
  radius: number;
  className: string;
}) {
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - pct / 100);
  const c = radius + 9;
  return (
    <svg className={className} viewBox={`0 0 ${c * 2} ${c * 2}`} aria-hidden="true">
      <circle className="track" cx={c} cy={c} r={radius} />
      <circle
        className="prog"
        cx={c}
        cy={c}
        r={radius}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${c} ${c})`}
      />
      <text className="pct" x={c} y={c} textAnchor="middle" dominantBaseline="central">
        {pct}%
      </text>
    </svg>
  );
}

/**
 * The per-concept check question. Answering correctly promotes a `locked` concept to `learning`
 * (the prototype's `wirePanel`), which is the one place mastery changes without an explicit
 * "mark as mastered" click.
 */
function ConceptQuiz({
  detail,
  analyticsEnabled,
  onCorrect,
}: {
  detail: DetailState | undefined;
  analyticsEnabled: boolean;
  onCorrect: () => void;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const quiz = detail?.kind === "ready" ? detail.detail.quiz : null;

  if (!quiz || quiz.options.length === 0) {
    return <p className="muted-note">No quiz available for this concept.</p>;
  }

  const done = picked !== null;
  return (
    <div className="quiz-q">
      <div className="q-q">{plainText(quiz.q)}</div>
      <div className="q-opts">
        {quiz.options.map((option, i) => {
          const cls = done ? (i === quiz.answer ? "correct" : i === picked ? "wrong" : "") : "";
          return (
            <button
              key={i}
              className={`q-opt${cls ? ` ${cls}` : ""}`}
              type="button"
              disabled={done}
              onClick={() => {
                if (picked !== null) return;
                setPicked(i);
                if (analyticsEnabled) {
                  posthog.capture("concept_quiz_answered", {
                    is_correct: i === quiz.answer,
                    option_count: quiz.options.length,
                  });
                }
                if (i === quiz.answer) onCorrect();
              }}
            >
              <span className="k">{String.fromCharCode(65 + i)}</span>
              {plainText(option)}
            </button>
          );
        })}
      </div>
      {done && (
        <div className="q-fb">
          <b>{picked === quiz.answer ? "Correct." : "Not quite."}</b> {plainText(quiz.explanation)}
        </div>
      )}
    </div>
  );
}

function Flashcards({
  detail,
  cardIndex,
  onCardIndex,
}: {
  detail: DetailState | undefined;
  cardIndex: number;
  onCardIndex: (index: number) => void;
}) {
  const [flipped, setFlipped] = useState(false);
  const cards = detail?.kind === "ready" ? detail.detail.flashcards : [];

  if (cards.length === 0) {
    return <p className="muted-note">No flashcards available for this concept.</p>;
  }

  const index = cardIndex % cards.length;
  const card = cards[index];
  return (
    <>
      <div
        className={`flash${flipped ? " flipped" : ""}`}
        role="button"
        tabIndex={0}
        aria-label="Flip the card"
        onClick={() => setFlipped((f) => !f)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setFlipped((f) => !f);
          }
        }}
      >
        <div className="flash-inner">
          <div className="flash-face flash-front">
            <span className="tag">Prompt</span>
            <div className="ft">{plainText(card.front)}</div>
          </div>
          <div className="flash-face flash-back">
            <span className="tag">Answer</span>
            <div className="bt">{plainText(card.back)}</div>
          </div>
        </div>
      </div>
      <div className="flash-hint">Click the card to flip</div>
      <div className="card-nav">
        <button
          type="button"
          disabled={index === 0}
          onClick={() => {
            setFlipped(false);
            onCardIndex(cardIndex - 1);
          }}
        >
          Previous
        </button>
        <span className="card-count">
          {index + 1} / {cards.length}
        </span>
        <button
          type="button"
          disabled={index >= cards.length - 1}
          onClick={() => {
            setFlipped(false);
            onCardIndex(cardIndex + 1);
          }}
        >
          Next
        </button>
      </div>
    </>
  );
}

/** Local helper so the panel does not need the whole graph plumbed through twice. */
function prerequisitesOf(concepts: GraphConcept[], edges: GraphEdge[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const { slug } of concepts) map.set(slug, []);
  for (const edge of edges) {
    if (!map.has(edge.prerequisite) || !map.has(edge.dependent)) continue;
    const list = map.get(edge.dependent)!;
    if (!list.includes(edge.prerequisite)) list.push(edge.prerequisite);
  }
  return map;
}

/** Kept for parity with the prototype's mastery pip ordering. */
export { masteryValue };

function IconCheck() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconArrow() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
