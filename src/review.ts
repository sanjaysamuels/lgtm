// Runs the review by shelling out to the Claude Code CLI in headless mode.
// Default is a single high-standards pass; `deep: true` runs the multi-phase
// pr-af-style pipeline in ./protocol.

import { claudeJson } from "./claude.ts";
import type { Finding, PrContext, ReviewResult, Severity } from "./types.ts";
import { buildReviewPrompt } from "./prompt.ts";
import { deepReviewPr } from "./protocol/pipeline.ts";

const VALID_SEV: Severity[] = ["critical", "warning", "info"];

function normalize(raw: unknown): ReviewResult {
  const obj = raw as Record<string, unknown>;
  const rawFindings = Array.isArray(obj.findings) ? obj.findings : [];
  const seen = new Set<string>();

  const findings: Finding[] = rawFindings.map((r, i) => {
    const f = r as Record<string, unknown>;
    const sev = VALID_SEV.includes(f.sev as Severity)
      ? (f.sev as Severity)
      : "info";
    let id = typeof f.id === "string" && f.id ? f.id : `finding-${i + 1}`;
    while (seen.has(id)) id = `${id}-${i}`;
    seen.add(id);
    return {
      id,
      sev,
      cat: str(f.cat, "General"),
      verify: Boolean(f.verify),
      title: str(f.title, "Untitled finding"),
      file: str(f.file, "(unknown)"),
      line: Number.isFinite(Number(f.line)) ? Math.trunc(Number(f.line)) : 0,
      issue: str(f.issue, ""),
      why: str(f.why, ""),
      code: str(f.code, ""),
      suggestion: str(f.suggestion, ""),
      comment: str(f.comment, str(f.title, "")),
    };
  });

  const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.sev] - order[b.sev]);

  const strengths = Array.isArray(obj.strengths)
    ? obj.strengths.filter((s): s is string => typeof s === "string")
    : [];

  return {
    summary: str(obj.summary, ""),
    findings,
    strengths,
  };
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

export interface ReviewOptions {
  model?: string;
  onProgress?: (msg: string) => void;
  /** Extra documentation (project standards, design docs, notes) to weigh the review against. */
  extraContext?: string;
  /** Run the deep multi-phase pr-af-style pipeline instead of a single pass. */
  deep?: boolean;
}

export async function reviewPr(
  pr: PrContext,
  opts: ReviewOptions = {},
): Promise<ReviewResult> {
  if (opts.deep) {
    return deepReviewPr(pr, {
      model: opts.model,
      extraContext: opts.extraContext,
      onProgress: opts.onProgress,
    });
  }

  const prompt = buildReviewPrompt(pr, opts.extraContext);
  opts.onProgress?.("Running review with Claude…");
  const raw = await claudeJson(prompt, { model: opts.model });
  return normalize(raw);
}
