// Posts the triaged review back to GitHub via `gh`.

import { ghWithStdin } from "./fetch.ts";
import type {
  PostComment,
  PostPayload,
  PostResult,
  PrContext,
} from "./types.ts";

// A finding is line-anchored (posts inline) when it has a positive line number
// and its file is one the PR actually changed. Matching against the real changed
// files is what tells a genuine path apart from a PR-level label, and unlike a
// string heuristic it handles paths that contain spaces.
function isInline(file: string, line: number, changed: Set<string>): boolean {
  return line > 0 && changed.has(file);
}

// The posted review body carries only genuine PR-level findings (the ones with
// no diff line to attach to). It omits the AI summary and any tool signature, so
// what lands on the PR is just the reviewer's comments. When every finding is
// inline the body is empty, which GitHub accepts for a review that has comments.
function buildBody(prLevel: PostComment[]): string {
  return prLevel
    .map((c) => c.body)
    .join("\n\n")
    .trim();
}

export async function postReview(
  pr: PrContext,
  payload: PostPayload,
): Promise<PostResult> {
  const changed = new Set(pr.files.map((f) => f.path));
  const inline = payload.comments.filter((c) => isInline(c.file, c.line, changed));
  const prLevel = payload.comments.filter((c) => !isInline(c.file, c.line, changed));
  const body = buildBody(prLevel);

  const reviewPayload = {
    event: payload.event,
    body,
    comments: inline.map((c) => ({
      path: c.file,
      line: c.line,
      side: "RIGHT" as const,
      body: c.body,
    })),
  };

  // Primary path: a single review with inline comments.
  try {
    const out = await ghWithStdin(
      [
        "api",
        "--method",
        "POST",
        `/repos/${pr.repo}/pulls/${pr.number}/reviews`,
        "--input",
        "-",
      ],
      JSON.stringify(reviewPayload),
    );
    const res = JSON.parse(out) as { html_url?: string };
    return {
      ok: true,
      mode: "review",
      url: res.html_url,
      inlineCount: inline.length,
    };
  } catch (primaryErr) {
    // Fallback: GitHub rejects a review when any inline line is outside the
    // diff. Post everything as one aggregated PR comment so the loop still
    // closes, and surface why inline failed.
    try {
      const md = buildAggregate(pr, payload, String(primaryErr));
      const out = await ghWithStdin(
        ["pr", "comment", String(pr.number), "--repo", pr.repo, "--body-file", "-"],
        md,
      );
      return {
        ok: true,
        mode: "comment-fallback",
        url: out.trim() || undefined,
        inlineCount: 0,
      };
    } catch (fallbackErr) {
      return {
        ok: false,
        mode: "failed",
        inlineCount: 0,
        error: `inline review failed (${primaryErr}); fallback comment failed (${fallbackErr})`,
      };
    }
  }
}

function buildAggregate(
  pr: PrContext,
  payload: PostPayload,
  reason: string,
): string {
  const lines: string[] = [`## review of PR #${pr.number}`, ""];
  for (const c of payload.comments) {
    const loc = c.line > 0 ? `\`${c.file}:${c.line}\`` : `\`${c.file}\``;
    lines.push(`- ${loc}: ${c.body}`);
  }
  lines.push(
    "",
    `_(posted as one comment because inline placement was rejected: ${reason.slice(0, 160)})_`,
  );
  return lines.join("\n");
}
