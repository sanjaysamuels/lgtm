// Builds the high-standards review prompt handed to `claude -p`.

import type { PrContext } from "./types.ts";

export function buildReviewPrompt(pr: PrContext, extraContext?: string): string {
  const fileList = pr.files
    .map((f) => `  ${f.path} (+${f.additions} -${f.deletions})`)
    .join("\n");

  const contextSection = extraContext?.trim()
    ? `

## Additional context supplied by the reviewer
The reviewer attached the documentation below (project standards, design docs,
requirements, or domain notes). Treat it as authoritative for this review: weight
the diff against it, and flag code that contradicts or ignores it. Where it
conflicts with a generic best practice, the reviewer's docs win.

${extraContext.trim()}`
    : "";

  return `You are a meticulous senior engineer performing a pull-request review at the
highest professional standard. Review the diff below and report only findings you
can justify from the code itself.

## Standards to apply, in priority order
1. Correctness — logic errors, wrong conditions, off-by-one, null/undefined and
   empty-collection edge cases, incorrect boundary/interval handling, race
   conditions, and behavioral changes that silently alter existing semantics.
2. Security & data safety — injection, secrets, auth/authorization gaps, unsafe
   deserialization, and (for health/finance/PII domains) any path that could
   silently drop or leak sensitive records.
3. Error handling — swallowed exceptions, missing logging/telemetry on failure,
   error paths that hide problems from users or monitoring.
4. Language & framework idioms for the detected stack (${pr.stack}) — follow the
   ecosystem's official style guide and conventions; prefer the idiomatic,
   optimized API over hand-rolled equivalents.
5. Tests — flag non-trivial logic changes (especially on hotfix/release branches)
   that ship without tests.
6. Clarity & maintainability — naming, dead code, fragile type coupling,
   undocumented non-obvious decisions.

Be specific and adversarial: prefer a few high-confidence findings over many weak
ones. When a finding depends on an assumption you cannot verify from the diff
(e.g. backend null semantics, callers outside the diff), set "verify" to true and
say what must be confirmed. Also record genuine strengths worth calling out.

## Pull request
Repo: ${pr.repo}   PR #${pr.number}
Title: ${pr.title}
Author: ${pr.author}
Base: ${pr.baseRefName}  Head: ${pr.headRefName}
Detected stack: ${pr.stack}
Changed files:
${fileList}

PR description:
${pr.body || "(none)"}
${contextSection}

## Diff
\`\`\`diff
${pr.diff}
\`\`\`

## Output format
Respond with ONE JSON object and nothing else — no prose, no markdown fence.
Schema:

{
  "summary": string,               // 1-3 sentence overall assessment
  "findings": [
    {
      "id": string,                // stable kebab-case slug
      "sev": "critical" | "warning" | "info",  // critical=correctness/security, warning=should-fix, info=nit/verify
      "cat": string,               // short category, e.g. "Correctness"
      "verify": boolean,           // true if it rests on an unconfirmed assumption
      "title": string,             // one-line headline
      "file": string,              // repo-relative path, or a PR-level label if not one file
      "line": number,              // 1-indexed new-file line; 0 if not line-specific
      "issue": string,             // what is wrong
      "why": string,               // why it matters
      "code": string,              // short snippet (may use +/- prefixes for diff lines)
      "suggestion": string,        // concrete fix
      "comment": string            // ready-to-post PR comment, in the author's voice (see Comment style)
    }
  ],
  "strengths": [ string ]          // things done well, phrased for the review
}

## Comment style (applies to the "comment" field only)
Write each "comment" the way this reviewer writes: short, to the point, and in
all lowercase. No capital letters anywhere, including the first word and proper
nouns. One or two sentences, plain and direct. No preamble, no pleasantries, no
"consider" hedging. Say the thing. Backticked \`code\`/identifiers are fine as-is.
Never use em dashes, en dashes, or a hyphen as a dash between clauses. Use a
period, comma, or parentheses instead (ordinary hyphens inside compound words are
fine). Examples of the tone:
  * "this misses ongoing admissions. dischargedAt is null so gte never matches, add a { dischargedAt: { eq: null } } branch like drug_user does."
  * "swallowing the error here hides a failing baseline. log it before returning null."
  * "no tests for this filter change on a hotfix branch. can we add one?"
Only the "comment" field uses this style. Keep "title", "issue", "why", and
"suggestion" in normal prose so the triage UI stays readable.

Rank findings most-severe first. If there are no findings, return an empty array.`;
}
