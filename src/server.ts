// Serves the triage GUI locally and handles the post-back request.

import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import type { PostPayload, PostResult, PrContext, ReviewResult } from "./types.ts";
import { postReview } from "./post.ts";

const DASHBOARD_URL = new URL("../web/dashboard.html", import.meta.url);

interface ServeOptions {
  pr: PrContext;
  review: ReviewResult;
  port?: number;
  onPosted?: (result: PostResult) => void;
  onClose?: () => void;
}

export interface RunningServer {
  url: string;
  server: Server;
  close: () => void;
}

function injectData(html: string, pr: PrContext, review: ReviewResult): string {
  const data = {
    pr: {
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
      author: pr.author,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
      baseRefName: pr.baseRefName,
      url: pr.url,
      stack: pr.stack,
    },
    summary: review.summary,
    findings: review.findings,
    strengths: review.strengths,
  };
  // Escape "</" so the JSON can't break out of the <script> element.
  const json = JSON.stringify(data).replace(/<\//g, "<\\/");
  return html.replace("__REVIEW_DATA__", json);
}

async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function serve(opts: ServeOptions): Promise<RunningServer> {
  const template = await readFile(DASHBOARD_URL, "utf8");
  const page = injectData(template, opts.pr, opts.review);

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page);
        return;
      }

      if (req.method === "POST" && req.url === "/api/post") {
        const payload = JSON.parse(await readBody(req)) as PostPayload;
        const result = await postReview(opts.pr, payload);
        res.writeHead(result.ok ? 200 : 500, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify(result));
        opts.onPosted?.(result);
        return;
      }

      if (req.method === "POST" && req.url === "/api/close") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        opts.onClose?.();
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
  });

  return new Promise<RunningServer>((resolve, reject) => {
    server.on("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      const url = `http://127.0.0.1:${port}`;
      resolve({
        url,
        server,
        close: () => server.close(),
      });
    });
  });
}
