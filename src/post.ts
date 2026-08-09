// Posts the triaged review back to GitHub via `gh`.

import { ghWithStdin } from "./fetch.ts";
import type {
  PostComment,
  PostPayload,
  PostResult,
  PrContext,
} from "./types.ts";

// Builds, per changed file, the set of new-file line numbers that GitHub will
// accept an inline comment on: the added ("+") and context (" ") lines inside
// each hunk. Deleted ("-") lines don't advance the new-file counter. This is the
// source of truth for whether a finding can be posted inline.
function commentableLinesByFile(diff: string): Map<string, Set<number>> {
  const byFile = new Map<string, Set<number>>();
  let cur: Set<number> | null = null;
  let newLine = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git") || raw.startsWith("index ")) {
      cur = null;
      continue;
    }
    if (raw.startsWith("--- ")) continue;
    if (raw.startsWith("+++ ")) {
      const m = raw.match(/^\+\+\+ b\/(.*)$/);
      if (m) {
        cur = new Set<number>();
        byFile.set(m[1].replace(/\t.*$/, ""), cur); // strip trailing tab on space paths
      } else {
        cur = null; // e.g. "+++ /dev/null" for a deleted file
      }
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (!cur) continue;
    const c = raw[0];
    if (c === "+") {
      cur.add(newLine);
      newLine++;
    } else if (c === " ") {
      cur.add(newLine);
      newLine++;
    } else if (c === "-") {
      // left side only; does not advance the new-file line counter
    }
  }
  return byFile;
}

// A finding posts inline only when it has a positive line that GitHub will
// actually accept on that file. Anything else (line 0, a PR-level label, or a
// line outside the diff) goes in the review body instead of sinking the whole
// inline review with a 422.
function canInline(
  file: string,
  line: number,
  commentable: Map<string, Set<number>>,
): boolean {
  return line > 0 && (commentable.get(file)?.has(line) ?? false);
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
  const commentable = commentableLinesByFile(pr.diff);
  const inline = payload.comments.filter((c) => canInline(c.file, c.line, commentable));
  const prLevel = payload.comments.filter((c) => !canInline(c.file, c.line, commentable));
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
