// Fetches PR context and diff from GitHub via the `gh` CLI.

import { spawn } from "node:child_process";
import type { PrContext, PrFile } from "./types.ts";

export interface PrRef {
  repo: string;
  number: number;
}

/** Accepts `owner/repo#123` or a full `https://github.com/owner/repo/pull/123` URL. */
export function parsePrRef(input: string): PrRef {
  const trimmed = input.trim();
  const url = trimmed.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (url) return { repo: url[1], number: Number(url[2]) };
  const short = trimmed.match(/^([^/\s]+\/[^/\s#]+)#(\d+)$/);
  if (short) return { repo: short[1], number: Number(short[2]) };
  throw new Error(
    `Could not parse PR reference "${input}". Use owner/repo#123 or a full PR URL.`,
  );
}

function gh(args: string[], stdin?: string): Promise<string> {
  // Uses spawn (not async execFile) because we must write the request body to
  // stdin and close it. Async execFile ignores its `input` option, which leaves
  // `gh --input -` blocked on stdin forever.
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) =>
      reject(new Error(`Failed to launch \`gh\`. Is the GitHub CLI installed? ${e.message}`)),
    );
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`gh ${args.join(" ")} failed: ${err.trim() || out.trim()}`));
      } else {
        resolve(out);
      }
    });
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

/** Runs `gh` with data piped to stdin (used for `gh api --input -`). */
export function ghWithStdin(args: string[], stdin: string): Promise<string> {
  return gh(args, stdin);
}

function inferStack(files: PrFile[]): string {
  const ext = new Set(
    files.map((f) => f.path.split(".").pop()?.toLowerCase() ?? ""),
  );
  const map: [string, string[]][] = [
    ["Flutter/Dart", ["dart"]],
    ["TypeScript", ["ts", "tsx"]],
    ["JavaScript", ["js", "jsx", "mjs", "cjs"]],
    ["Python", ["py"]],
    ["Go", ["go"]],
    ["Rust", ["rs"]],
    ["Java", ["java"]],
    ["Kotlin", ["kt", "kts"]],
    ["Swift", ["swift"]],
    ["Ruby", ["rb"]],
    ["C#", ["cs"]],
    ["C/C++", ["c", "cc", "cpp", "h", "hpp"]],
    ["PHP", ["php"]],
    ["GraphQL", ["graphql", "gql"]],
    ["SQL", ["sql"]],
  ];
  const labels = map
    .filter(([, exts]) => exts.some((e) => ext.has(e)))
    .map(([label]) => label);
  return labels.join(" · ") || "mixed";
}

export async function fetchPr(ref: PrRef): Promise<PrContext> {
  const metaRaw = await gh([
    "pr",
    "view",
    String(ref.number),
    "--repo",
    ref.repo,
    "--json",
    "title,author,additions,deletions,changedFiles,baseRefName,headRefName,url,body,files",
  ]);
  const meta = JSON.parse(metaRaw) as {
    title: string;
    author: { name?: string; login?: string } | null;
    additions: number;
    deletions: number;
    changedFiles: number;
    baseRefName: string;
    headRefName: string;
    url: string;
    body: string;
    files: PrFile[];
  };

  const diff = await gh([
    "pr",
    "diff",
    String(ref.number),
    "--repo",
    ref.repo,
  ]);

  const files: PrFile[] = (meta.files ?? []).map((f) => ({
    path: f.path,
    additions: f.additions,
    deletions: f.deletions,
  }));

  return {
    repo: ref.repo,
    number: ref.number,
    title: meta.title,
    author: meta.author?.name || meta.author?.login || "unknown",
    additions: meta.additions,
    deletions: meta.deletions,
    changedFiles: meta.changedFiles,
    baseRefName: meta.baseRefName,
    headRefName: meta.headRefName,
    url: meta.url,
    body: meta.body ?? "",
    stack: inferStack(files),
    files,
    diff,
  };
}
