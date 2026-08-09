// Runs the review by shelling out to the Claude Code CLI in headless mode.

import { spawn } from "node:child_process";
import type { Finding, PrContext, ReviewResult, Severity } from "./types.ts";
import { buildReviewPrompt } from "./prompt.ts";

interface ClaudeEnvelope {
  is_error?: boolean;
  result?: string;
  subtype?: string;
}

function runClaude(args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) =>
      reject(
        new Error(
          `Failed to launch \`claude\`. Is Claude Code installed and on PATH? ${e.message}`,
        ),
      ),
    );
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}: ${err.trim() || out.trim()}`));
      } else {
        resolve(out);
      }
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

/** Pulls a JSON object out of model output that may include prose or a fence. */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    return JSON.parse(fenced[1].trim());
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`No JSON object found in review output:\n${text.slice(0, 500)}`);
  }
  return JSON.parse(text.slice(start, end + 1));
}

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
}

export async function reviewPr(
  pr: PrContext,
  opts: ReviewOptions = {},
): Promise<ReviewResult> {
  const prompt = buildReviewPrompt(pr, opts.extraContext);
  const args = ["-p", "--output-format", "json"];
  if (opts.model) args.push("--model", opts.model);

  opts.onProgress?.("Running review with Claude…");
  const stdout = await runClaude(args, prompt);

  let envelope: ClaudeEnvelope;
  try {
    envelope = JSON.parse(stdout) as ClaudeEnvelope;
  } catch {
    throw new Error(`Could not parse claude output as JSON:\n${stdout.slice(0, 500)}`);
  }
  if (envelope.is_error) {
    throw new Error(`Claude reported an error: ${envelope.result ?? envelope.subtype}`);
  }
  if (!envelope.result) {
    throw new Error("Claude returned an empty result.");
  }

  return normalize(extractJson(envelope.result));
}
