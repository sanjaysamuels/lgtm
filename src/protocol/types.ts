// Internal types for the deep, pr-af-style review pipeline.
// These stay inside the protocol layer; the pipeline maps its output to the
// shared lgtm `Finding`/`ReviewResult` types the GUI and poster already use.

/** pr-af severity scale, richer than lgtm's three-level one. */
export type DeepSeverity = "critical" | "important" | "suggestion" | "nitpick";

/** Phase 1 — classify the PR to drive how deep the rest of the pipeline goes. */
export interface IntakeResult {
  pr_type: string; // feature | bugfix | refactor | docs | infra | mixed
  complexity: string; // trivial | standard | complex | massive
  areas_touched: string[]; // semantic areas: auth, database, api, frontend, config...
  risk_signals: string[]; // "touches auth", "modifies schema", ...
  ai_generated: number; // 0.0-1.0 confidence the PR is AI-generated
  review_depth: string; // quick | standard | deep
  pr_summary: string; // one-line what-this-does
}

/** Phase 2 — structural + semantic understanding of the change. */
export interface AnatomyResult {
  pr_narrative: string; // what the CODE does, traced end to end
  risk_surfaces: string[]; // non-obvious places this could break
  unrelated_changes: string[]; // changes that don't fit the PR's stated intent
  intent_gaps: string[]; // claimed-but-absent, or present-but-undescribed
}

/** Phase 3 — one focused, independently-executable investigation. */
export interface ReviewDimension {
  name: string; // short label
  review_prompt: string; // complete briefing for the dimension reviewer
  target_files: string[]; // files to scrutinise
  priority: number; // 1 = highest
}

export interface ReviewPlan {
  dimensions: ReviewDimension[];
}

/** Phase 4 — a finding produced by one dimension reviewer. */
export interface RawFinding {
  title: string;
  severity: DeepSeverity;
  file_path: string;
  line_start: number; // 1-indexed new-file line, 0 if PR-level
  body: string; // what's wrong and why it matters
  evidence: string; // step-by-step reachability / failure chain
  suggestion: string; // concrete fix
  confidence: number; // 0.0-1.0 reviewer self-assessment
  comment: string; // ready-to-post comment in the reviewer's voice
  dimension: string; // which dimension found it
}

export type Verdict = "confirmed" | "challenged" | "escalated";

/** Phase 5 — the adversary's ruling on one finding. */
export interface AdversaryVerdict {
  index: number; // position in the findings list handed to the adversary
  verdict: Verdict;
  reason: string;
  severity?: DeepSeverity; // revised severity when escalated/downgraded
}
