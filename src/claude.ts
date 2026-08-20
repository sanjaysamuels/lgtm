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

/** Pulls a JSON value out of model output that may include prose or a code fence. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return JSON.parse(fenced[1].trim());
  // Objects and arrays are both valid top-level payloads in this pipeline.
  const objStart = text.indexOf("{");
  const arrStart = text.indexOf("[");
  const start =
    arrStart !== -1 && (objStart === -1 || arrStart < objStart) ? arrStart : objStart;
  const open = text[start];
  const close = open === "[" ? "]" : "}";
  const end = text.lastIndexOf(close);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`No JSON found in model output:\n${text.slice(0, 500)}`);
  }
  return JSON.parse(text.slice(start, end + 1));
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
