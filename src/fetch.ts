// Fetches PR context and diff from GitHub via the `gh` CLI.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PrContext, PrFile } from "./types.ts";

const execFileP = promisify(execFile);

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

async function gh(args: string[], stdin?: string): Promise<string> {
  try {
    const { stdout } = await execFileP("gh", args, {
      maxBuffer: 32 * 1024 * 1024,
      ...(stdin !== undefined ? { input: stdin } : {}),
    });
    return stdout;
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    throw new Error(
      `gh ${args.join(" ")} failed: ${err.stderr?.trim() || err.message || String(e)}`,
    );
  }
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
