// Shared type definitions for lgtm.

export type Severity = "critical" | "warning" | "info";

export interface Finding {
  /** Stable kebab-case identifier. */
  id: string;
  /** critical = correctness/security; warning = should fix; info = nit/verify. */
  sev: Severity;
  /** Short category label, e.g. "Correctness", "Error handling". */
  cat: string;
  /** True when the finding depends on an assumption the human must confirm. */
  verify: boolean;
  title: string;
  /** Repo-relative path, or a PR-level label when not tied to one file. */
  file: string;
  /** 1-indexed line in the new file; 0 when not line-specific (PR-level). */
  line: number;
  /** What is wrong. */
  issue: string;
  /** Why it matters. */
  why: string;
  /** Short code snippet illustrating the finding. */
  code: string;
  /** Suggested fix. */
  suggestion: string;
  /** Ready-to-post PR comment (the human may edit it before posting). */
  comment: string;
  /** Deep pipeline only: step-by-step reachability/failure chain. */
  evidence?: string;
  /** Deep pipeline only: reviewer confidence, 0.0-1.0. */
  confidence?: number;
  /** Deep pipeline only: adversary ruling on the finding. */
  verdict?: "confirmed" | "escalated";
  /** Deep pipeline only: post-worthiness judged this worth posting. */
  recommended?: boolean;
}

export interface ReviewResult {
  summary: string;
  findings: Finding[];
  strengths: string[];
}

export interface PrFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface PrContext {
  repo: string; // owner/repo
  number: number;
  title: string;
  author: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  baseRefName: string;
  headRefName: string;
  url: string;
  body: string;
  stack: string;
  files: PrFile[];
  diff: string;
}

export type ReviewEvent = "COMMENT" | "REQUEST_CHANGES" | "APPROVE";

export interface PostComment {
  id: string;
  file: string;
  line: number;
  body: string;
}

export interface PostPayload {
  event: ReviewEvent;
  summary: string;
  comments: PostComment[];
}

export interface PostResult {
  ok: boolean;
  mode: "review" | "comment-fallback" | "failed";
  url?: string;
  inlineCount: number;
  error?: string;
}
