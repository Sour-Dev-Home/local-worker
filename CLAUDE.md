# local-worker

MCP server (+ devlog CLI) that delegates bulk reading and drafting to a local Ollama
model. TypeScript, ESM, Node 22+. See README.md for what it does and its security model.

## Ground rules

1. **No PII or hardcoded local paths in committed files.** No real name as identifying
   data, personal email, phone number, account usernames, or absolute local paths
   (e.g. `C:\Users\...`). Examples use placeholders like `/path/to/...`. The CI
   `security` job greps for this; CLAUDE.md files are excluded because they document the
   patterns. **One deliberate exception:** `LICENSE` names the copyright holder by real
   name, so the owner can prove authorship. Keep the name there and nowhere else, and
   don't "fix" it.
2. **The path checks are the security boundary.** Any change to `src/paths.ts`, or any
   new code that reads or writes a caller-supplied path, needs tests for `..` traversal,
   symlinks, other drives and case folding, and a `security-reviewer` pass before merge.
   Every file write (MCP tools and the devlog CLI) goes through `resolveWritable` (fail
   fast) AND `safeWriteFile` (re-checks at write time); never `fs.writeFile` a validated
   path directly, and never let another process (e.g. the browser) write to it. Every read
   of a caller-supplied path goes through `readConfinedFile`. Don't loosen the write-name
   rules (no dot-directories/dotfiles, no CLAUDE.md/AGENTS.md/requirements*.txt, ...):
   they stop model output from persisting as agent or build instructions.
3. **The model's output is never trusted.** Tools must keep labelling results
   "unverified"; nothing in this repo may act on model output (run it, commit it, publish
   it) without a human or a Claude session checking it first.
4. **Branch + PR for every change.** `main` is protected; CI (`verify`, `security`) must
   pass. PRs that change logic are drafts until a fresh `test-hunter` pass is done (see
   the workspace WORKFLOW.md).
5. **CI can't reach a GPU.** Unit tests stub the model and the browser; run
   `node scripts/smoke.mjs` locally against a real Ollama before merging changes to
   `server.ts`, `ollama.ts` or `pdf.ts`.
