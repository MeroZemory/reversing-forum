# Project workflow

- Start from the broad product frame in README.md and the current priority in TODO.md.
- Implement a usable flow before expanding policies or architecture. Add newly discovered work to TODO.md.
- Ask for product decisions only when they materially block the current implementation.
- Exclude ROOT session `01a0fd15-7ee5-7412-a281-2d4d4ac37f77` from all report recipients. The user cancelled the earlier root notification requirement; send no progress, results, resends, acknowledgments, or confirmations to it.
- Continue project work and communicate directly with the project user, including requests for sample approval. ROOT is not this project's management or review session. Apply this routing to project report workers as well.
- Preserve legacy/ as reference. Build the new app under src/.
- Never publish raw KakaoTalk backups or include authentication keys in code, logs, fixtures, or commits.
- Public queries must exclude pending/held posts. Only their author may view them.
- Keep Jev screening evidence private; publish only after a passing result. API errors keep posts private.
- Use real server sessions for writes. Validate data and reply ownership on the server.
- Inherit global model settings. Do not add project model/effort overrides for complexity alone.
- Run typecheck, relevant tests, and a build before handoff. Browser checks run headlessly.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
