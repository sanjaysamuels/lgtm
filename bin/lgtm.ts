#!/usr/bin/env node
// lgtm — AI PR review with a local triage GUI. Say LGTM and mean it.
//
// Usage:
//   lgtm <owner/repo#123 | PR-url> [--model <name>] [--port <n>] [--no-open]

import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { fetchPr, parsePrRef } from "../src/fetch.ts";
import { reviewPr } from "../src/review.ts";
import { serve } from "../src/server.ts";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => {
    /* best-effort; the URL is printed regardless */
  });
  child.unref();
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      model: { type: "string" },
      port: { type: "string" },
      "no-open": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(`${c.bold("lgtm")} — AI PR review with a local triage GUI

Usage:
  lgtm <owner/repo#123 | PR-url> [options]

Options:
  --model <name>   Claude model to review with (default: your CLI default)
  --port <n>       Port for the local GUI (default: random free port)
  --no-open        Don't auto-open the browser
  -h, --help       Show this help
`);
    process.exit(positionals.length === 0 ? 1 : 0);
  }

  const ref = parsePrRef(positionals[0]);
  const label = `${ref.repo}#${ref.number}`;

  process.stdout.write(c.dim(`→ Fetching ${label}…`) + "\n");
  const pr = await fetchPr(ref);
  console.log(
    c.dim(
      `  ${c.bold(pr.title)}  ${c.green("+" + pr.additions)} ${c.red("-" + pr.deletions)}  ${pr.changedFiles} files  ·  ${pr.stack}`,
    ),
  );

  process.stdout.write(c.dim("→ Reviewing to high standards (this can take a minute)…") + "\n");
  const started = Date.now();
  const review = await reviewPr(pr, {
    model: values.model,
    onProgress: (m) => process.stdout.write(c.dim(`  ${m}`) + "\n"),
  });
  const secs = ((Date.now() - started) / 1000).toFixed(0);

  const crit = review.findings.filter((f) => f.sev === "critical").length;
  const warn = review.findings.filter((f) => f.sev === "warning").length;
  const info = review.findings.filter((f) => f.sev === "info").length;
  console.log(
    `  ${c.green("✓")} ${review.findings.length} findings in ${secs}s  ` +
      `(${c.red(crit + " critical")}, ${c.yellow(warn + " should-fix")}, ${info} nits)  ` +
      `· ${review.strengths.length} strengths`,
  );

  const running = await serve({
    pr,
    review,
    port: values.port ? Number(values.port) : undefined,
    onPosted: (result) => {
      if (result.ok) {
        console.log(
          c.green(`\n✓ Posted to GitHub`) +
            c.dim(
              ` (${result.mode}${result.inlineCount ? `, ${result.inlineCount} inline` : ""})`,
            ),
        );
        if (result.url) console.log(c.dim(`  ${result.url}`));
      } else {
        console.log(c.red(`\n✗ Post failed: ${result.error}`));
      }
    },
    onClose: () => {
      console.log(c.dim("\n→ Closing."));
      running.close();
      process.exit(0);
    },
  });

  console.log(`\n${c.bold("Triage:")} ${c.cyan(running.url)}`);
  console.log(c.dim("  Keep / dismiss / edit findings, then Post. Ctrl+C to quit.\n"));
  if (!values["no-open"]) openBrowser(running.url);
}

main().catch((e) => {
  console.error(c.red(`\nlgtm: ${e instanceof Error ? e.message : String(e)}`));
  process.exit(1);
});
