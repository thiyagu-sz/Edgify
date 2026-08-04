"use client";

import { useMemo, useState } from "react";
import { NoticeBanner, OutputHead, QuizView } from "@/components/notes/quick-notes";
import { FORMATS, getFormat } from "@/lib/ai/prompts";
import type { Quiz } from "@/lib/ai/schemas";
import { DEMO_NOTES } from "@/lib/demo/notes";
import { exportDoc, exportPdf } from "@/lib/export";
import { renderMarkdown } from "@/lib/sanitize";

/**
 * Quick Notes, signed out — the format switcher over the curated samples in lib/demo/notes.ts.
 *
 * There is no generator here, and that is the honest shape rather than a shortcut: with no
 * account there is no quota, no ledger and no document, so there is nothing to generate FROM.
 * What the demo can show truthfully is the output — every format, the interactive quiz, and the
 * real export — which is what a visitor is deciding about.
 *
 * The quiz, the demo banner and the export header are the SAME components the signed-in
 * workspace renders (imported from components/notes/quick-notes), so this cannot drift into a
 * look-alike. Only the orchestration differs.
 *
 * NO NETWORK. The live component fetches usage, streams a generation and posts uploads; none of
 * those exist here, which is what makes "demo content is never written to any user's records"
 * true by construction rather than by branch.
 */

/** A quiz rendered for export. The on-screen quiz is `QuizView`; this is the take-away copy. */
function quizToMarkdown(quiz: Quiz): string {
  return quiz.questions
    .map((q, i) => {
      const options = q.options
        .map((opt, oi) => `   ${oi === q.answer ? "**" : ""}${String.fromCharCode(97 + oi)}. ${opt}${oi === q.answer ? "**" : ""}`)
        .join("\n");
      return `${i + 1}. ${q.q}\n\n${options}\n\n   _${q.explanation}_`;
    })
    .join("\n\n");
}

const isQuiz = (value: string | Quiz): value is Quiz =>
  typeof value !== "string" && Array.isArray(value.questions);

export function DemoQuickNotes() {
  const [formatId, setFormatId] = useState(FORMATS[0].id);
  const format = getFormat(formatId) ?? FORMATS[0];
  const sample = DEMO_NOTES[formatId];

  const markdown = useMemo(() => {
    if (sample === undefined) return "";
    return isQuiz(sample) ? quizToMarkdown(sample) : sample;
  }, [sample]);

  return (
    <div className="feature" id="feature-notes">
      <div className="card qn-input">
        <div className="fmt-label">Revision format</div>
        <div className="format-chips">
          {FORMATS.map((f) => (
            <button
              key={f.id}
              className="fmt"
              type="button"
              aria-pressed={f.id === formatId}
              onClick={() => setFormatId(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="fmt-desc">{format.desc}</div>
      </div>

      <div className="card qn-output">
        {sample === undefined ? (
          <div className="out-body">
            <NoticeBanner notice="demo" />
            <p className="fmt-desc">
              No sample is prepared for this format yet. Every other format on the left has one,
              and the live workspace generates all nine from your own material.
            </p>
          </div>
        ) : (
          <>
            <OutputHead
              label={format.label}
              chars={markdown.length}
              showCopy={!isQuiz(sample)}
              onCopy={() => void navigator.clipboard?.writeText(markdown)}
              onPdf={() => exportPdf(`Edgify — ${format.label}`, markdown)}
              onDoc={() => exportDoc(`Edgify — ${format.label}`, markdown)}
              /** No generator in demo mode: switching format is the only thing to re-do. */
              onRegenerate={() => setFormatId(formatId)}
            />
            <div className="out-body">
              <NoticeBanner notice="demo" />
              {isQuiz(sample) ? (
                <QuizView key={formatId} quiz={sample} />
              ) : (
                // Sanitised at the single chokepoint (lib/sanitize) before this innerHTML.
                <div className="prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(sample) }} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
