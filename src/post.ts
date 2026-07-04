// Posts the triaged review back to GitHub via `gh`.

import { ghWithStdin } from "./fetch.ts";
import type { PostPayload, PostResult, PrContext } from "./types.ts";

function isInline(file: string, line: number): boolean {
  // A real, line-anchored finding: a path with a directory separator and a
  // positive line number. PR-level items (line 0, label strings) go in the body.
  return line > 0 && file.includes("/") && !file.includes(" ");
}

function buildBody(payload: PostPayload, prLevel: { body: string }[]): string {
  const parts: string[] = [];
  if (payload.summary.trim()) parts.push(payload.summary.trim());
  if (prLevel.length) {
    parts.push(
      "**Additional notes**\n" +
        prLevel.map((c) => `- ${c.body}`).join("\n"),
    );
  }
  parts.push("_Reviewed with lgtm._");
  return parts.join("\n\n");
}

export async function postReview(
  pr: PrContext,
  payload: PostPayload,
): Promise<PostResult> {
  const inline = payload.comments.filter((c) => isInline(c.file, c.line));
  const prLevel = payload.comments.filter((c) => !isInline(c.file, c.line));
  const body = buildBody(payload, prLevel);

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
  const lines: string[] = [`## Review — PR #${pr.number}`, ""];
  if (payload.summary.trim()) lines.push(payload.summary.trim(), "");
  for (const c of payload.comments) {
    const loc = c.line > 0 ? `\`${c.file}:${c.line}\`` : `\`${c.file}\``;
    lines.push(`- **${loc}** — ${c.body}`);
  }
  lines.push(
    "",
    `_Posted as a single comment because inline placement was rejected (${reason.slice(0, 160)}). Reviewed with lgtm._`,
  );
  return lines.join("\n");
}
