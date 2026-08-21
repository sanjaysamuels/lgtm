# lgtm

**AI pull-request review with a local triage GUI. Now you can say LGTM and mean it.**

"LGTM" — _Looks Good To Me_ — is what everyone types when they approve a PR without
really reading it. `lgtm` reads it for you: it fetches a PR, reviews the diff to a
high standard with Claude, and hands you a browser dashboard where you keep / dismiss /
edit each finding — then posts the ones you approve back to GitHub as a review. You
stay the reviewer of record; the AI just does the reading.

```
lgtm owner/repo#123
   │
   ├─ fetch    gh pr diff / view            → diff + PR context
   ├─ review   claude -p (headless)         → structured findings
   ├─ triage   local server + browser GUI   → you keep/dismiss/edit
   └─ post     gh api / gh pr comment       → comments land on the PR
```

## Requirements

- **Node ≥ 22** (runs the TypeScript sources directly — no build step)
- **[`gh`](https://cli.github.com/)**, authenticated with `repo` scope (`gh auth status`)
- **[Claude Code](https://claude.com/claude-code)** (`claude`) installed and signed in

## Install

```sh
git clone https://github.com/sanjaysamuels/lgtm.git && cd lgtm
npm install            # dev types only; no runtime dependencies
npm link               # optional: puts `lgtm` on your PATH
```

Or run without linking:

```sh
node bin/lgtm.ts owner/repo#123
```

## Usage

```sh
lgtm greensheart/greensheart-app#213
lgtm https://github.com/owner/repo/pull/42
lgtm owner/repo#42 --model claude-opus-4-8 --port 8080 --no-open
lgtm owner/repo#42 --docs docs/standards.md --docs ARCHITECTURE.md
lgtm owner/repo#42 --context "this is a hotfix branch, be strict about tests"
```

| Flag | Meaning |
|------|---------|
| `--model <name>` | Claude model to review with (default: your CLI default) |
| `--port <n>`     | Port for the local GUI (default: a random free port) |
| `--docs <path>`  | Attach a doc file as extra review context (repeatable) |
| `--context <text>` | Inline notes the review is weighed against |
| `--no-open`      | Don't auto-open the browser |
| `-h, --help`     | Show help |

### Extra documentation

`--docs` and `--context` feed the reviewer authoritative context beyond the diff:
project standards, design docs, requirements, or a note about the branch. The
review weighs the diff against them and flags code that contradicts or ignores
them. Pass `--docs` once per file, and `--context` for a quick inline note.

The command fetches the PR, runs the review, then serves the triage GUI and opens
it. In the browser you:

1. Read each finding (issue, why it matters, the code, a suggested fix).
2. **Keep**, **Dismiss**, or edit the ready-to-post comment.
3. Pick a review type — Comment / Request changes / Approve — and **Post**.

Line-anchored findings post as inline review comments; anything not tied to a diff
line goes in the review body. If GitHub rejects an inline position, `lgtm` falls
back to posting everything as one aggregated PR comment so nothing is lost.

## How it works

| Stage | Module | Notes |
|-------|--------|-------|
| Fetch | `src/fetch.ts` | `gh pr view --json` + `gh pr diff`; infers the stack from file extensions |
| Review | `src/review.ts`, `src/prompt.ts` | pipes a high-standards prompt to `claude -p --output-format json`, parses the findings |
| Serve | `src/server.ts`, `web/dashboard.html` | Node `http` server hydrates the GUI template; no external deps |
| Post | `src/post.ts` | `gh api …/reviews` for inline comments, `gh pr comment` fallback |

## Limitations & roadmap

- **Single-pass review.** One `claude -p` call. Good at catching the big issues;
  a deeper multi-pass / multi-lens mode (correctness · security · tests, each
  verified) is the natural next step for higher recall.
- No config file yet (per-language standards profiles, default model).
- Inline posting depends on lines being present in the diff.

## License

MIT.
