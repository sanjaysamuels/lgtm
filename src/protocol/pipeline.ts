// The deep review pipeline: a port of Agent-Field/pr-af's protocol driven by
// `claude -p`. Runs intake -> anatomy -> planning -> parallel dimension reviews
// -> adversary -> post-worthiness, then maps the survivors onto lgtm's shared
// Finding/ReviewResult types so the existing GUI and poster work unchanged.

import { claudeJson } from "../claude.ts";
import type { Finding, PrContext, ReviewResult, Severity } from "../types.ts";
import * as P from "./prompts.ts";
import type {
  AdversaryVerdict,
  AnatomyResult,
  DeepSeverity,
  IntakeResult,
  RawFinding,
  ReviewDimension,
  ReviewPlan,
} from "./types.ts";

export interface DeepOptions {
  model?: string;
  extraContext?: string;
  onProgress?: (msg: string) => void;
  /** Hard cap on how many dimensions run (default 8). */
  maxDimensions?: number;
}

const VALID_DEEP_SEV: DeepSeverity[] = [
  "critical",
  "important",
  "suggestion",
  "nitpick",
];

const DIMENSION_CONCURRENCY = 4;

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function deepSev(v: unknown): DeepSeverity {
  return VALID_DEEP_SEV.includes(v as DeepSeverity) ? (v as DeepSeverity) : "suggestion";
}

// pr-af's four-level scale collapses onto lgtm's three.
function toSeverity(s: DeepSeverity): Severity {
  if (s === "critical") return "critical";
  if (s === "important") return "warning";
  return "info"; // suggestion, nitpick
}

// Runs `worker` over `items` with a bounded number in flight at once.
async function pool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function run(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, run);
  await Promise.all(runners);
  return results;
}

export async function deepReviewPr(
  pr: PrContext,
  opts: DeepOptions = {},
): Promise<ReviewResult> {
  const progress = opts.onProgress ?? (() => {});
  const model = opts.model;
  const maxDimensions = opts.maxDimensions ?? 8;

  // Phase 1: Intake
  progress("intake: classifying the PR…");
  const intakeRaw = await claudeJson<Record<string, unknown>>(
    P.buildIntakePrompt(pr),
    { model },
  );
  const intake: IntakeResult = {
    pr_type: str(intakeRaw.pr_type, "mixed"),
    complexity: str(intakeRaw.complexity, "standard"),
    areas_touched: strArr(intakeRaw.areas_touched),
    risk_signals: strArr(intakeRaw.risk_signals),
    ai_generated: num(intakeRaw.ai_generated),
    review_depth: str(intakeRaw.review_depth, "deep"),
    pr_summary: str(intakeRaw.pr_summary, pr.title),
  };

  // Phase 2: Anatomy
  progress("anatomy: mapping what the code does and where the risk is…");
  const anatomyRaw = await claudeJson<Record<string, unknown>>(
    P.buildAnatomyPrompt(pr, intake),
    { model },
  );
  const anatomy: AnatomyResult = {
    pr_narrative: str(anatomyRaw.pr_narrative),
    risk_surfaces: strArr(anatomyRaw.risk_surfaces),
    unrelated_changes: strArr(anatomyRaw.unrelated_changes),
    intent_gaps: strArr(anatomyRaw.intent_gaps),
  };

  // Phase 3: Planning
  progress("planning: crafting review dimensions for this PR…");
  const planRaw = await claudeJson<Record<string, unknown>>(
    P.buildPlanPrompt(pr, intake, anatomy, opts.extraContext),
    { model },
  );
  const dimensions: ReviewDimension[] = (
    Array.isArray(planRaw.dimensions) ? planRaw.dimensions : []
  )
    .map((d) => {
      const o = d as Record<string, unknown>;
      return {
        name: str(o.name, "review"),
        review_prompt: str(o.review_prompt),
        target_files: strArr(o.target_files),
        priority: num(o.priority, 5),
      };
    })
    .filter((d) => d.review_prompt.length > 0)
    .sort((a, b) => a.priority - b.priority)
    .slice(0, maxDimensions);

  if (dimensions.length === 0) {
    // Planner produced nothing usable; nothing to review deeply.
    return { summary: anatomy.pr_narrative || intake.pr_summary, findings: [], strengths: [] };
  }
  progress(`planning: ${dimensions.length} dimensions → reviewing in parallel…`);

  // Phase 4: Parallel dimension reviews
  const dimNames = dimensions.map((d) => d.name);
  let done = 0;
  const perDimension = await pool(dimensions, DIMENSION_CONCURRENCY, async (dim) => {
    const others = dimNames.filter((n) => n !== dim.name);
    const out = await claudeJson<Record<string, unknown>>(
      P.buildDimensionPrompt(pr, dim, intake, anatomy, others, opts.extraContext),
      { model },
    );
    done++;
    progress(`  reviewed ${done}/${dimensions.length}: ${dim.name}`);
    const raw = Array.isArray(out.findings) ? out.findings : [];
    return raw.map((r): RawFinding => {
      const o = r as Record<string, unknown>;
      return {
        title: str(o.title, "Untitled finding"),
        severity: deepSev(o.severity),
        file_path: str(o.file_path, "(unknown)"),
        line_start: Math.trunc(num(o.line_start)),
        body: str(o.body),
        evidence: str(o.evidence),
        suggestion: str(o.suggestion),
        confidence: num(o.confidence, 0.6),
        comment: str(o.comment, str(o.title, "")),
        dimension: dim.name,
      };
    });
  });

  // Drop below-threshold confidence up front; the gates asked for >= 0.6.
  let findings = perDimension.flat().filter((f) => f.confidence >= 0.6);
  if (findings.length === 0) {
    return {
      summary: anatomy.pr_narrative || intake.pr_summary,
      findings: [],
      strengths: [],
    };
  }

  // Phase 5: Adversary — challenge every finding, drop the false positives.
  progress(`adversary: challenging ${findings.length} findings…`);
  const verdicts = await claudeJson<unknown>(
    P.buildAdversaryPrompt(pr, findings),
    { model },
  );
  const byIndex = new Map<number, AdversaryVerdict>();
  if (Array.isArray(verdicts)) {
    for (const v of verdicts) {
      const o = v as Record<string, unknown>;
      const idx = Math.trunc(num(o.index, -1));
      if (idx < 0) continue;
      const verdict = str(o.verdict) as AdversaryVerdict["verdict"];
      byIndex.set(idx, {
        index: idx,
        verdict:
          verdict === "confirmed" || verdict === "challenged" || verdict === "escalated"
            ? verdict
            : "confirmed",
        reason: str(o.reason),
        severity: o.severity ? deepSev(o.severity) : undefined,
      });
    }
  }

  const survivors: (RawFinding & { verdict: "confirmed" | "escalated" })[] = [];
  findings.forEach((f, i) => {
    // Default to keeping when the adversary said nothing about this index.
    const v = byIndex.get(i);
    if (v?.verdict === "challenged") return;
    if (v?.severity) f.severity = v.severity; // apply escalation/downgrade
    survivors.push({ ...f, verdict: v?.verdict === "escalated" ? "escalated" : "confirmed" });
  });
  progress(`adversary: ${survivors.length}/${findings.length} survived`);

  if (survivors.length === 0) {
    return {
      summary: anatomy.pr_narrative || intake.pr_summary,
      findings: [],
      strengths: [],
    };
  }

  // Phase 6: Post-worthiness — which survivors are actually worth posting.
  progress("deciding which findings are worth posting…");
  const recommended = new Set<number>();
  try {
    const pw = await claudeJson<Record<string, unknown>>(
      P.buildPostWorthyPrompt(survivors),
      { model },
    );
    for (const idx of Array.isArray(pw.keep_indices) ? pw.keep_indices : []) {
      const n = Math.trunc(num(idx, -1));
      if (n >= 0) recommended.add(n);
    }
  } catch {
    // If this phase fails, recommend everything the adversary confirmed.
    survivors.forEach((_, i) => recommended.add(i));
  }

  // Map onto lgtm's Finding shape. Recommended-first, then by severity.
  const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  const seen = new Set<string>();
  const mapped: Finding[] = survivors.map((f, i) => {
    let id = f.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || `finding-${i + 1}`;
    while (seen.has(id)) id = `${id}-${i}`;
    seen.add(id);
    const sev = toSeverity(f.severity);
    return {
      id,
      sev,
      cat: f.dimension,
      verify: f.confidence < 0.85,
      title: f.title,
      file: f.file_path,
      line: f.line_start > 0 ? f.line_start : 0,
      issue: f.body,
      why: f.evidence,
      code: "",
      suggestion: f.suggestion,
      comment: f.comment,
      evidence: f.evidence,
      confidence: f.confidence,
      verdict: f.verdict,
      recommended: recommended.has(i),
    };
  });

  mapped.sort((a, b) => {
    if (!!b.recommended !== !!a.recommended) return b.recommended ? 1 : -1;
    return order[a.sev] - order[b.sev];
  });

  const strengths: string[] = [];
  if (anatomy.unrelated_changes.length) {
    strengths.push(`Unrelated changes flagged: ${anatomy.unrelated_changes.join("; ")}`);
  }

  const recCount = mapped.filter((f) => f.recommended).length;
  const summary =
    `${anatomy.pr_narrative || intake.pr_summary} ` +
    `Deep review ran ${dimensions.length} dimensions; ${recCount} of ${mapped.length} findings recommended for posting.`;

  return { summary: summary.trim(), findings: mapped, strengths };
}
