"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { demoGraphTransport, demoGraphView } from "@/components/graph/demo-transport";
import { KnowledgeGraph } from "@/components/graph/knowledge-graph";
import { DemoQuickNotes } from "./demo-quick-notes";

/**
 * The signed-out `/demo` workspace — both features behind the prototype's two-mode switcher.
 *
 * The switcher is local state rather than routing, which is the one structural difference from
 * the signed-in TopBar (where it is two `<Link>`s and the active pill follows the pathname).
 * `/demo` is a single page with no server data, so a route change would buy nothing and cost a
 * navigation.
 *
 * The KNOWLEDGE GRAPH here is the real `KnowledgeGraph` component, given `demoGraphTransport`
 * and a graph up front — not a copy. Every behaviour the acceptance criterion names (the graph,
 * per-concept quizzes and flashcards, readiness, the study plan, PDF/DOC export) is therefore
 * the same code the signed-in workspace runs. What it does NOT have is any means of reaching the
 * network: see the note on `GraphTransport` in components/graph/types.
 *
 * `.claude/rules/ui.md` requires demo content to be labelled always, never silently substituted.
 * The banner below is persistent — not dismissible, not shown once — and both features carry
 * their own labelling underneath it.
 */
export function DemoWorkspace() {
  const [feature, setFeature] = useState<"notes" | "graph">("graph");
  /** Built once: re-deriving it per render would reset the graph's own state on every keystroke. */
  const graph = useMemo(() => demoGraphView(), []);

  return (
    <div className="edgify-workspace">
      <header className="topbar">
        <Link href="/" className="brand" aria-label="Edgify — home">
          <svg className="mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <line x1="12" y1="5.5" x2="5.5" y2="17.5" stroke="#111" strokeWidth="1.6" strokeLinecap="round" />
            <line x1="12" y1="5.5" x2="18.5" y2="17.5" stroke="#111" strokeWidth="1.6" strokeLinecap="round" />
            <line x1="5.5" y1="17.5" x2="18.5" y2="17.5" stroke="#111" strokeWidth="1.6" strokeLinecap="round" />
            <circle cx="12" cy="5.5" r="2.7" fill="#111" />
            <circle cx="5.5" cy="17.5" r="2.7" fill="#111" />
            <circle cx="18.5" cy="17.5" r="2.7" fill="#111" />
          </svg>
          <span className="word">edgify</span>
        </Link>
        <div className="nav-spacer" />
        <div className="pill-group" role="tablist" aria-label="Feature">
          <button
            className="seg"
            type="button"
            role="tab"
            aria-selected={feature === "notes"}
            onClick={() => setFeature("notes")}
          >
            Quick notes
          </button>
          <button
            className="seg"
            type="button"
            role="tab"
            aria-selected={feature === "graph"}
            onClick={() => setFeature("graph")}
          >
            Knowledge graph
          </button>
        </div>
        <div className="nav-spacer" />
        <Link href="/notes" className="btn-primary">
          Launch workspace
        </Link>
      </header>

      <div className="notice-banner" role="status">
        <span>
          <b>This is a demo.</b> Everything below is prepared sample content — a machine-learning
          graph and worked revision notes — so you can try the workspace without signing in.
          Nothing here is saved. Launch the workspace to use your own material.
        </span>
      </div>

      <main>
        {feature === "graph" ? (
          <KnowledgeGraph initialGraphId={null} initialGraph={graph} transport={demoGraphTransport} />
        ) : (
          <DemoQuickNotes />
        )}
      </main>
    </div>
  );
}
