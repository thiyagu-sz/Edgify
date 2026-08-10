"use client";

import { useCallback, useRef, useState } from "react";
import { FORMATS, getFormat } from "@/lib/ai/prompts";
import { sanitizeQuiz, type Quiz } from "@/lib/ai/schemas";
import { exportDoc, exportPdf, quizToMarkdown } from "@/lib/export";
import { quotaState } from "@/lib/notes/quota-display";
import { renderMarkdown } from "@/lib/sanitize";

/**
 * Quick Notes — the interactive workspace island (W2, docs/05), a faithful React port of the
 * prototype's Quick Notes UI (docs/reference/edgify-prototype.html). The prototype called the
 * model from the browser; here every generation goes through POST /api/notes/generate, which
 * owns the key, the ladder and the ledger (AGENTS.md #1/#3). Markdown streams; quizzes come back
 * validated. Model output is sanitised before render (renderMarkdown); quiz text is React-escaped.
 */

/** The prototype's sample source text — used by "Load sample" so the user can try it instantly. */
const SAMPLE =
  "Neural networks learn by adjusting the strengths of connections between artificial neurons until their outputs match the desired targets. A network is organised into layers: an input layer receives the data, one or more hidden layers transform it, and an output layer produces the prediction. Each connection carries a weight, and each neuron computes a weighted sum of its inputs followed by a nonlinear activation function, which allows the network to represent complex, nonlinear relationships.\n\nTraining relies on a loss function that measures how far the network's predictions fall from the correct answers, and the goal is to minimise this loss. The backpropagation algorithm computes how much each weight contributed to the error by applying the chain rule of calculus, propagating gradients backward from the output layer to the input layer. An optimiser such as gradient descent then updates every weight a small step in the direction that reduces the loss.\n\nRepeating this process over many examples gradually improves the network's accuracy. The learning rate controls the size of each update: too large and training becomes unstable, too small and it converges slowly.";

const MIN_CHARS = 200;
const STREAM_TIMEOUT_MS = 45_000;

type Notice = "demo" | "quota" | null;

/**
 * The uploaded document's lifecycle (W3, docs/05), surfaced in the input card.
 *
 * `uploading` and `extracting` are two genuinely different things — the bytes leaving the browser,
 * then the server parsing them — and the split is measured, not simulated: `XMLHttpRequest`
 * reports real upload progress and fires `upload.onload` the moment the request body is fully
 * sent, which is exactly the boundary between the two. One request, no polling, no invented
 * percentages.
 */
type DocState =
  | { kind: "idle" }
  | { kind: "uploading"; name: string; percent: number | null }
  | { kind: "extracting"; name: string }
  | { kind: "ready"; name: string; chars: number }
  | { kind: "error"; message: string };

type ExtractBody = { text?: string; charCount?: number; message?: string };

/** The catalogue's generic fallback (docs/04 §7) — never a status code or a stack. */
const EXTRACT_FAILED =
  "That file couldn't be read. It may be damaged — try re-saving or exporting it again.";

/**
 * POST the file to /api/documents/extract, reporting the upload→extract handover as it happens.
 *
 * `fetch` cannot express this: it resolves only once the response is complete, so with it the
 * whole operation is a single opaque wait and "Uploading…" could only ever be a guess. XHR
 * exposes the send phase, so both states are real. Same route, same contract, same single request.
 */
function extractDocument(
  file: File,
  onPhase: (phase: { kind: "uploading"; percent: number | null } | { kind: "extracting" }) => void,
): Promise<ExtractBody> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/documents/extract");

    xhr.upload.onprogress = (e) => {
      onPhase({
        kind: "uploading",
        percent: e.lengthComputable && e.total > 0 ? Math.round((e.loaded / e.total) * 100) : null,
      });
    };
    // The body is fully sent; everything after this is the server reading the document.
    xhr.upload.onload = () => onPhase({ kind: "extracting" });

    xhr.onload = () => {
      try {
        resolve(JSON.parse(xhr.responseText) as ExtractBody);
      } catch {
        resolve({ message: EXTRACT_FAILED });
      }
    };
    // A dropped connection or an aborted request is ours to explain, not the user's to decode.
    xhr.onerror = () => resolve({ message: "Something went wrong on our side. Please try again in a moment." });
    xhr.onabort = () => resolve({ message: EXTRACT_FAILED });

    const form = new FormData();
    form.set("file", file);
    xhr.send(form);
  });
}

type OutState =
  | { kind: "empty" }
  | { kind: "loading"; label: string }
  | { kind: "prose"; md: string; notice: Notice; streaming: boolean; chars: number; label: string }
  | { kind: "quiz"; quiz: Quiz; notice: Notice; chars: number; label: string; genId: number }
  | { kind: "error"; title: string; message: string };

export function QuickNotes({
  initialRemaining,
  initialLimit,
}: {
  initialRemaining: number | null;
  initialLimit: number | null;
}) {
  const [text, setText] = useState("");
  const [formatId, setFormatId] = useState(FORMATS[0].id);
  const [out, setOut] = useState<OutState>({ kind: "empty" });
  const [remaining, setRemaining] = useState(initialRemaining);
  const [limit, setLimit] = useState(initialLimit);
  /** The uploaded document's visible state. Idle means "no document involved". */
  const [doc, setDoc] = useState<DocState>({ kind: "idle" });
  /**
   * Extracted document text — held here and NEVER rendered. It is the source the generator reads
   * when a document is loaded, which is why the textarea no longer has to carry it: dumping a
   * whole PDF into the paste box made the input area look broken and gave the user a wall of text
   * to scroll past for no benefit. The wire contract to /api/notes/generate is unchanged; only
   * where the client keeps the string has moved.
   */
  const [docText, setDocText] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const genIdRef = useRef(0);
  /** True for the whole of a generation, streaming included, so runs cannot overlap. */
  const runningRef = useRef(false);

  const format = getFormat(formatId) ?? FORMATS[0];
  /** A loaded document is the source material; otherwise it is whatever is in the textarea. */
  const source = docText ?? text;
  const docLoaded = docText !== null;

  const refreshQuota = useCallback(async () => {
    try {
      const res = await fetch("/api/usage", { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { remaining: number | null; limit: number | null };
      setRemaining(body.remaining ?? null);
      setLimit(body.limit ?? null);
    } catch {
      // The counter is a nicety; ignore a failed refresh.
    }
  }, []);

  const generate = useCallback(async () => {
    // A run in flight owns the output panel. Without this, ⌘Enter during a stream starts a
    // second generation that races the first into the same state (and spends a second quota).
    if (runningRef.current) return;
    const content = source.trim();
    const fmt = getFormat(formatId) ?? FORMATS[0];
    if (content.length < MIN_CHARS) {
      setOut({
        kind: "error",
        title: "Not enough text yet",
        message: "There isn't enough text here to work with. Add a few paragraphs.",
      });
      return;
    }

    const chars = content.length;
    const genId = ++genIdRef.current;
    runningRef.current = true;
    setOut({ kind: "loading", label: `Generating ${fmt.label.toLowerCase()}…` });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);
    try {
      const res = await fetch("/api/notes/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: content, format: fmt.id }),
        signal: controller.signal,
      });
      const kind = res.headers.get("X-Edgify-Kind");

      if (kind === "stream" && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let md = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          md += decoder.decode(value, { stream: true });
          setOut({ kind: "prose", md, notice: null, streaming: true, chars, label: fmt.label });
        }
        md += decoder.decode();
        setOut({ kind: "prose", md, notice: null, streaming: false, chars, label: fmt.label });
        await refreshQuota();
        return;
      }

      const body = (await res.json().catch(() => ({}))) as {
        data?: unknown;
        notice?: Notice;
        message?: string;
      };

      if (kind === "final") {
        if (fmt.mode === "quiz") {
          const quiz = sanitizeQuiz(body.data);
          if (!quiz) {
            setOut({
              kind: "error",
              title: "Unexpected quiz format",
              message: "The quiz came back in an unexpected format. Try generating it again.",
            });
          } else {
            setOut({ kind: "quiz", quiz, notice: body.notice ?? null, chars, label: fmt.label, genId });
          }
        } else {
          const md = typeof body.data === "string" ? body.data : "";
          setOut({ kind: "prose", md, notice: body.notice ?? null, streaming: false, chars, label: fmt.label });
        }
        await refreshQuota();
      } else if (kind === "busy") {
        setOut({
          kind: "error",
          title: "The server is busy",
          message: body.message ?? "Server is busy, please try again in a moment.",
        });
      } else if (kind === "auth") {
        setOut({
          kind: "error",
          title: "Session expired",
          message: body.message ?? "Please sign in again to continue.",
        });
      } else if (kind === "message") {
        // Something the user can fix (too short / too long). Not a server fault, so it must not
        // read as one — docs/04 §7: say what happened, and offer the next action.
        setOut({
          kind: "error",
          title: "Check the source material",
          message: body.message ?? "There isn't enough text here to work with. Add a few paragraphs.",
        });
      } else {
        setOut({
          kind: "error",
          title: "Something went wrong",
          message: body.message ?? "Something went wrong on our side. Please try again in a moment.",
        });
      }
    } catch {
      // Abort/timeout or network drop. Keep any partial stream; otherwise show the calm busy state.
      setOut((prev) =>
        prev.kind === "prose" && prev.md.trim().length > 0
          ? { ...prev, streaming: false }
          : {
              kind: "error",
              title: "The server is busy",
              message: "Server is busy, please try again in a moment.",
            },
      );
    } finally {
      clearTimeout(timeout);
      runningRef.current = false;
    }
  }, [source, formatId, refreshQuota]);

  /** Drop the document and hand the textarea back to the user. */
  const clearDoc = useCallback(() => {
    setDocText(null);
    setDoc({ kind: "idle" });
  }, []);

  function loadSample() {
    // The sample IS the source material, so a loaded document has to go — otherwise it would keep
    // winning over the text the user just asked for, and "Load sample" would appear to do nothing.
    clearDoc();
    setText(SAMPLE);
    textRef.current?.focus();
  }

  function onTextKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void generate();
    }
  }

  const currentMarkdown = useCallback((): string => {
    if (out.kind === "prose") return out.md;
    if (out.kind === "quiz") return quizToMarkdown(out.label, out.quiz.questions);
    return "";
  }, [out]);

  /**
   * Upload → extract → ready (W3, docs/05), reported as it happens.
   *
   * The extracted text is deliberately NOT written to the textarea any more. Showing it was
   * meant to prove extraction worked, but a whole document pasted into the input box reads as a
   * glitch rather than as confirmation. The named states below prove it instead, and say more:
   * a silent failure is now an explicit `error` state rather than an empty box.
   *
   * Extraction stays side-effect free on the server — no document row, no quota, no model call
   * (app/api/documents/extract) — so trying a file still costs the user nothing.
   */
  const onFilePicked = useCallback(async (file: File) => {
    if (runningRef.current) return;
    // Synchronous, before any await: the user must never watch an unchanged screen after picking.
    setDocText(null);
    setDoc({ kind: "uploading", name: file.name, percent: null });

    const body = await extractDocument(file, (phase) => {
      setDoc(
        phase.kind === "uploading"
          ? { kind: "uploading", name: file.name, percent: phase.percent }
          : { kind: "extracting", name: file.name },
      );
    });

    if (typeof body.text === "string" && body.text.trim().length > 0) {
      setDocText(body.text);
      setDoc({
        kind: "ready",
        name: file.name,
        chars: body.charCount ?? body.text.length,
      });
      return;
    }

    // Every failure already carries its own next action (docs/04 §7) — the scanned-PDF message
    // points at pasting, the oversize one at a smaller file. Do not append another.
    setDoc({ kind: "error", message: body.message ?? EXTRACT_FAILED });
  }, []);

  const quota = quotaState(remaining, limit);
  // Disabled for the whole run — the spinner AND the streaming phase. Re-enabling once the first
  // token lands would invite a second generation on top of the one still writing.
  const busy = out.kind === "loading" || (out.kind === "prose" && out.streaming);
  /** A document mid-flight is not yet source material, so nothing may generate from it. */
  const docBusy = doc.kind === "uploading" || doc.kind === "extracting";

  return (
    <div className="qn-grid">
      {/* ── Input ─────────────────────────────────────────────────────────── */}
      <div className="card qn-input">
        <div className="qn-label">
          Source material
          <div className="qn-actions">
            <button
              className="link"
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy || docBusy}
            >
              <IconUpload /> Upload file
            </button>
            <button className="link" type="button" onClick={loadSample} disabled={docBusy}>
              <IconSample /> Load sample
            </button>
          </div>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.docx,.txt,.md,.markdown,application/pdf,text/plain,text/markdown"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Reset first, so picking the same file twice still fires a change event.
            e.target.value = "";
            if (file) void onFilePicked(file);
          }}
        />
        <DocStatus doc={doc} onRemove={clearDoc} onRetry={() => fileRef.current?.click()} />
        <textarea
          ref={textRef}
          className="paste"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onTextKeyDown}
          // A loaded document is the source material, so the box is not an editable second
          // source that would silently lose to it. Removing the document hands it straight back.
          disabled={docLoaded}
          placeholder="Paste your notes, a textbook section, or an article — or upload a PDF, DOCX, TXT or MD file above…"
        />
        <div className="char">{source.length.toLocaleString()} characters</div>
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
        <div className="gen-row">
          <button
            className="btn-primary"
            type="button"
            onClick={() => void generate()}
            disabled={busy || docBusy}
          >
            <IconArrow /> Generate revision notes
          </button>
          <div className="gen-hint">
            or press <kbd>⌘ Enter</kbd>
          </div>
          {quota.show && (
            <div className={`quota-note${quota.exhausted ? " exhausted" : ""}`}>{quota.text}</div>
          )}
        </div>
      </div>

      {/* ── Output ────────────────────────────────────────────────────────── */}
      <div className="card qn-output">
        {out.kind === "empty" && <EmptyState />}
        {out.kind === "loading" && <LoadingState label={out.label} />}
        {out.kind === "error" && (
          <ErrorState title={out.title} message={out.message} onRetry={() => void generate()} />
        )}
        {(out.kind === "prose" || out.kind === "quiz") && (
          <>
            <OutputHead
              label={out.label}
              chars={out.chars}
              showCopy={out.kind === "prose"}
              onCopy={() => void navigator.clipboard?.writeText(currentMarkdown())}
              onPdf={() => exportPdf(`Edgify — ${out.label}`, currentMarkdown())}
              onDoc={() => exportDoc(`Edgify — ${out.label}`, currentMarkdown())}
              onRegenerate={() => void generate()}
            />
            <div className="out-body">
              {out.notice && <NoticeBanner notice={out.notice} />}
              {out.kind === "prose" ? (
                // Sanitised at the single chokepoint (lib/sanitize) before this innerHTML.
                <div
                  className="prose"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(out.md) }}
                />
              ) : (
                <QuizView key={out.genId} quiz={out.quiz} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Interactive quiz with live scoring (prototype `renderQuizOutput`). Text is React-escaped.
 *
 * Exported since Phase 6 so `/demo` renders the SAME quiz, banner and export header as the real
 * workspace rather than look-alikes. Only the orchestration around them differs, and it differs
 * for a real reason: the demo has nothing to generate.
 */
export function QuizView({ quiz }: { quiz: Quiz }) {
  const [answers, setAnswers] = useState<(number | null)[]>(() => quiz.questions.map(() => null));
  const total = quiz.questions.length;
  const answered = answers.filter((a) => a !== null).length;
  const correct = answers.reduce<number>(
    (n, a, i) => (a !== null && a === quiz.questions[i].answer ? n + 1 : n),
    0,
  );

  return (
    <>
      <div className="quiz-score">
        <span>{answered === total ? "Final score" : "Quiz progress"}</span>
        <span className="rs">
          {correct} / {total}
        </span>
      </div>
      {quiz.questions.map((q, qi) => {
        const sel = answers[qi];
        const done = sel !== null;
        return (
          <div className="quiz-q" key={qi}>
            <div className="qnum">Question {qi + 1}</div>
            <div className="q-q">{q.q}</div>
            <div className="q-opts">
              {q.options.map((opt, oi) => {
                const cls = done ? (oi === q.answer ? "correct" : oi === sel ? "wrong" : "") : "";
                return (
                  <button
                    key={oi}
                    className={`q-opt${cls ? ` ${cls}` : ""}`}
                    type="button"
                    disabled={done}
                    onClick={() =>
                      setAnswers((prev) => {
                        if (prev[qi] !== null) return prev;
                        const next = [...prev];
                        next[qi] = oi;
                        return next;
                      })
                    }
                  >
                    <span className="k">{String.fromCharCode(65 + oi)}</span>
                    {opt}
                  </button>
                );
              })}
            </div>
            {done && (
              <div className="q-fb">
                <b>{sel === q.answer ? "Correct." : "Not quite."}</b> {q.explanation}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

export function NoticeBanner({ notice }: { notice: Exclude<Notice, null> }) {
  return (
    <div className="notice-banner" role="status">
      <IconInfo />
      {notice === "quota" ? (
        <span>
          <b>You&apos;ve used today&apos;s generations.</b> Here&apos;s a worked example in the
          meantime. Your limit resets at midnight.
        </span>
      ) : (
        <span>
          <b>Showing sample content.</b> Live generation is temporarily unavailable, so this is a
          prepared example. Your document is safe — try again in a few minutes.
        </span>
      )}
    </div>
  );
}

export function OutputHead({
  label,
  chars,
  showCopy,
  onCopy,
  onPdf,
  onDoc,
  onRegenerate,
}: {
  label: string;
  chars: number;
  showCopy: boolean;
  onCopy: () => void;
  onPdf: () => void;
  onDoc: () => void;
  onRegenerate: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="out-head">
      <div className="ot">
        {label} <span className="badge">from {chars.toLocaleString()} chars</span>
      </div>
      <div className="out-tools">
        {showCopy && (
          <button
            type="button"
            onClick={() => {
              onCopy();
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <IconCheck /> : <IconCopy />}
            {copied ? "Copied" : "Copy"}
          </button>
        )}
        <button type="button" onClick={onPdf}>
          <IconDownload /> PDF
        </button>
        <button type="button" onClick={onDoc}>
          <IconDownload /> DOC
        </button>
        <button type="button" onClick={onRegenerate}>
          <IconRefresh /> Regenerate
        </button>
      </div>
    </div>
  );
}

/**
 * The document's state, inline in the input card (STATE 1–5).
 *
 * Built from the W4 upload primitives already in the stylesheet — `.file-row`, `.file-ic`,
 * `.mspin` — so this is the same loading vocabulary the graph modal uses, not a second one. It
 * stays inline and compact deliberately: the graph's full-screen overlay is the wrong weight for
 * a step that usually takes a second or two.
 *
 * `role="status"` announces each transition to a screen reader without stealing focus; the
 * failure is a `role="alert"` because it needs saying at once. Nothing here is focus-trapped.
 */
function DocStatus({
  doc,
  onRemove,
  onRetry,
}: {
  doc: DocState;
  onRemove: () => void;
  onRetry: () => void;
}) {
  if (doc.kind === "idle") return null;

  if (doc.kind === "error") {
    return (
      <div className="file-row doc-status err" role="alert">
        <div className="file-ic" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" width="18" height="18">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
            <path d="M12 8v5M12 16.5v.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </div>
        <div className="doc-body">
          <div className="fn">Couldn&apos;t process this document</div>
          <div className="fs">{doc.message}</div>
        </div>
        <div className="doc-acts">
          <button className="link" type="button" onClick={onRetry}>
            Try again
          </button>
          <button className="doc-x" type="button" onClick={onRemove} aria-label="Dismiss">
            ✕
          </button>
        </div>
      </div>
    );
  }

  if (doc.kind === "ready") {
    return (
      <div className="file-row doc-status done" role="status">
        <div className="file-ic" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" width="18" height="18">
            <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div className="doc-body">
          <div className="fn">Document ready</div>
          {/* A filename is user-supplied and untrusted; React escapes it (.claude/rules/ui.md). */}
          <div className="fs">
            {doc.name} · {doc.chars.toLocaleString()} characters
          </div>
        </div>
        <div className="doc-acts">
          <button className="doc-x" type="button" onClick={onRemove} aria-label="Remove document">
            ✕
          </button>
        </div>
      </div>
    );
  }

  const uploading = doc.kind === "uploading";
  return (
    <div className="file-row doc-status" role="status">
      <div className="file-ic" aria-hidden="true">
        <div className="mspin" />
      </div>
      <div className="doc-body">
        <div className="fn">
          {uploading
            ? `Uploading document…${doc.percent !== null ? ` ${doc.percent}%` : ""}`
            : "Extracting document…"}
        </div>
        <div className="fs">
          {uploading
            ? doc.name
            : "Reading your document and preparing it for processing."}
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty">
      <svg className="eglyph" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <line x1="12" y1="5.5" x2="5.5" y2="17.5" stroke="#111" strokeWidth="1.4" strokeLinecap="round" />
        <line x1="12" y1="5.5" x2="18.5" y2="17.5" stroke="#111" strokeWidth="1.4" strokeLinecap="round" />
        <line x1="5.5" y1="17.5" x2="18.5" y2="17.5" stroke="#111" strokeWidth="1.4" strokeLinecap="round" />
        <circle cx="12" cy="5.5" r="2.4" fill="#111" />
        <circle cx="5.5" cy="17.5" r="2.4" fill="#111" />
        <circle cx="18.5" cy="17.5" r="2.4" fill="#111" />
      </svg>
      <h3>Your revision notes will appear here</h3>
      <p>Paste or upload material and choose a format to generate.</p>
    </div>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="loading">
      <div className="spin" />
      <p>{label}</p>
    </div>
  );
}

function ErrorState({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="errbox">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
        <path d="M12 8v5M12 16.5v.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <h3>{title}</h3>
      <p>{message}</p>
      <button className="btn-secondary" type="button" onClick={onRetry}>
        <span>Try again</span>
      </button>
    </div>
  );
}

/* ── Icons (ported from the prototype) ─────────────────────────────────────── */
function IconUpload() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 16V4M12 4l-5 5M12 4l5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 17v2a1 1 0 001 1h12a1 1 0 001-1v-2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
function IconSample() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M14 3v5h5M6 3h8l5 5v11a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
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
function IconCopy() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M5 15V5a2 2 0 012-2h10" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
function IconCheck() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconDownload() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 15V4M12 15l-4-4M12 15l4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 19h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function IconRefresh() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 12a8 8 0 0113.5-5.7L20 8M20 12a8 8 0 01-13.5 5.7L4 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconInfo() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <path d="M12 11v5M12 8v.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
