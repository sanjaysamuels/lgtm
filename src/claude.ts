// Shared helper for calling the Claude Code CLI in headless JSON mode.
// Used by both the fast single-pass review and the deep pr-af-style pipeline.

import { spawn } from "node:child_process";

interface ClaudeEnvelope {
  is_error?: boolean;
  result?: string;
  subtype?: string;
}

function runClaude(args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
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

function tryParse(s: string): unknown | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// Returns the balanced {...} or [...] starting at startIdx, respecting string
// literals and escapes so braces/brackets inside string values don't confuse the
// match. This is why we don't use indexOf/lastIndexOf: a `}` inside an evidence
// string would otherwise cut the payload short.
function balancedSlice(text: string, startIdx: number): string | undefined {
  const open = text[startIdx];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return text.slice(startIdx, i + 1);
  }
  return undefined;
}

/**
 * Pulls a JSON value out of model output that may include prose or a code fence.
 * Objects and arrays are both valid top-level payloads in this pipeline. Tries,
 * in order: the whole string, each fenced block, a greedy fence (for JSON whose
 * own strings contain ``` fences), then a balanced scan from every `{`/`[`.
 */
export function extractJson(text: string): unknown {
  const whole = tryParse(text.trim());
  if (whole !== undefined) return whole;

  for (const m of text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g)) {
    const p = tryParse(m[1].trim());
    if (p !== undefined) return p;
  }
  const greedy = text.match(/```(?:json)?\s*\n?([\s\S]*)```/);
  if (greedy) {
    const p = tryParse(greedy[1].trim());
    if (p !== undefined) return p;
  }
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{" || text[i] === "[") {
      const slice = balancedSlice(text, i);
      if (slice) {
        const p = tryParse(slice);
        if (p !== undefined) return p;
      }
    }
  }
  throw new Error(`No parseable JSON found in model output:\n${text.slice(0, 800)}`);
}

export interface ClaudeJsonOptions {
  model?: string;
}

/** Runs one `claude -p` call and returns the parsed JSON payload from its result. */
export async function claudeJson<T = unknown>(
  prompt: string,
  opts: ClaudeJsonOptions = {},
): Promise<T> {
  const args = ["-p", "--output-format", "json"];
  if (opts.model) args.push("--model", opts.model);

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
  if (!envelope.result) throw new Error("Claude returned an empty result.");
  return extractJson(envelope.result) as T;
}
