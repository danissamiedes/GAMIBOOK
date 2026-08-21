# CLAUDE.md

Project: Ledger — small-business accounting with consultant time tracking.
The build spec is `SPEC.md`; decisions and deviations go in `DECISIONS.md`.

## Working with this user

- **Always ask questions in clickable format.** Use the AskUserQuestion tool with
  concrete options rather than posing questions in prose. This applies to every
  question — scope, design choices, defaults, next steps — not just big ones.
  If a question genuinely has no discrete options (e.g. "send me the file"),
  still offer the choices around it (send now / proceed without it / etc.).
- Recommend a default: put it first and mark it "(Recommended)".

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
