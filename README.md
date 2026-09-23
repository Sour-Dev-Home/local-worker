# local-worker

An [MCP](https://modelcontextprotocol.io) server that lets Claude Code hand **bulk reading
and first drafts** to a model running on your own GPU through [Ollama](https://ollama.com),
so large inputs never enter Claude's context window. It also ships a CLI that drafts a
weekly developer log from a repo's merged pull requests.

The point is token economics. Every turn of a Claude Code session re-sends the whole
conversation, so pasting a 3,000-line CI log or a 60 KB diff into it costs tokens on every
later turn too. `local-worker` reads the file on your machine, has a local model extract
what's needed, and returns a few hundred tokens.

## Tools

| Tool | What it does |
|---|---|
| `local_llm` | Runs an instruction over up to 20 text files on the local model and returns only the answer, or writes it to `output_path` (a `.md` or `.txt` file) and returns a one-line confirmation. |
| `render_pdf` | Converts Markdown to a styled PDF (`output_path` must end in `.pdf`) with a headless Chromium-based browser. Deterministic, no model involved. |
| `local_status` | Reports whether Ollama is up, which models are installed and loaded, and how much of each is on the GPU. |

## What it's good at, and what it isn't

Measured on a Radeon RX 9070 (16 GB VRAM) via Ollama's Vulkan backend, `gpt-oss:20b`
fully in VRAM:

| Task | Input | Time | Result |
|---|---|---|---|
| Per-file summary of a PR diff | 57 KB (~16K tokens) | 37 s | Accurate; the most specific claim checked out against the source |
| List open items from a status doc | 14 KB | 15 s | All 5 items, names quoted exactly |
| Same items as JSON (`qwen3:14b`) | 16 KB | 15 s | Valid JSON, correct |
| Mermaid architecture diagram from six ADRs | 16 KB | 35 s | **Not usable as-is**: one wrong data flow, one contradictory edge, labels Mermaid can't parse |

So the tool descriptions steer the calling agent to use it for the gist of large inputs
and for drafts it will check, and **never** for code edits, security or correctness
decisions, or anything stated as fact without spot-checking the source. A 20B model is a
good reader and a mediocre authority.

## Security model

The server reads and writes files on behalf of an AI agent, so it's deliberately narrow:

- **Allowed roots.** Files may only be read from or written to `LOCAL_WORKER_ROOTS`
  (default: only the server's working directory; the OS temp dir isn't a default because
  it's world-writable on Linux). Roots and paths are resolved to their real paths
  *before* the check, so symlinks and junctions can't escape and a root that is itself a
  link still works. `..` traversal and other drives are rejected, and comparisons are
  case-insensitive on Windows and macOS (BMP one-to-one letter mappings only, so
  look-alikes such as the Kelvin sign don't match ASCII `k`; macOS is assumed to use the
  default case-insensitive volume format).
- **Reads** are limited to regular files of at most 8 MiB. Each file is opened once
  (with `O_NOFOLLOW` where the OS has it), and with the handle open the server re-checks
  that the path still resolves to itself inside a root and that the handle is the same
  file (device and inode) that now sits at that path. It then reads at most 8 MiB + 1
  bytes from the handle. So a link or file swapped in while the file is being opened
  is refused, not read. A file that is hard-linked into a root is read as that file.
- **Writes** go only to `.md`/`.txt` (`local_llm`) or `.pdf` (`render_pdf`) files. They
  never go into a `.git` directory, into any dot-directory below the root (`.claude`,
  `.github`, `.vscode`, `.cursor`, `.husky`, ...) or to a dotfile. They never go to an
  agent-instruction or build file: `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`,
  `GEMINI.md`, `CMakeLists.txt`, `requirements*.txt` or `constraints*.txt`, in any case.
  Those files are read as instructions by later agent sessions, CI or build tools, so
  model output landing there would be a persisted prompt injection. Writes also never go
  through a symlink, over a directory or over a file with other hard links, and never
  replace an existing file unless `overwrite: true`.
  The destination is validated *before* the model runs, so a bad path fails fast instead
  of after minutes of GPU time, and again at write time. The content goes to a temp file
  in the (re-verified) real parent directory, then gets committed. Without `overwrite`
  the commit is an exclusive-create copy, which fails if anything exists at the target by
  then, on any filesystem. With `overwrite` it's a rename, which replaces the directory
  entry and doesn't write through a link. So a file that appears while the model runs is
  never clobbered, and a planted link is never followed. A microsecond window remains in
  which the parent directory could be swapped between the final check and the commit.
  Portable Node can't close it.
- **Prompt injection.** File contents are framed as data, and the system prompt says so.
  That's a mitigation, not a guarantee, which is one more reason the output is always
  labelled "unverified".
- **PDF rendering.** Raw HTML in the markdown (`<script>`, `<img>`, `<meta>`, ...) is
  escaped and shows up as text. The page also carries a Content-Security-Policy
  (`default-src 'none'; style-src 'unsafe-inline'; img-src data:`) that blocks scripts,
  frames and every fetch, including `file:` URLs (which would let a document embed any
  local image and, on Windows, make SMB requests to `file://host/`). So markdown images
  must be `data:` URIs; local image files aren't embedded. The browser prints into a
  private temp directory, with every hostname mapped to "not found"
  (`--host-resolver-rules`) as a second layer. The PDF is then moved into place with the
  same checks as other writes. (Disabling scripts with a browser flag was tried first: headless Edge then
  silently skips printing.)
- **Network.** It only talks to `OLLAMA_URL` (default `http://127.0.0.1:11434`). Keep
  Ollama bound to localhost.
- **Not for CI.** Using this from GitHub Actions would need a self-hosted runner on your
  machine, which GitHub advises against for public repositories. It's designed to be
  called by local Claude Code sessions.

## Setup

Requires Node 22+, [Ollama](https://ollama.com/download), and for `render_pdf` Edge,
Chrome or Chromium.

```sh
ollama pull gpt-oss:20b        # default model, best for long documents (~13 GB)
ollama pull qwen3:14b          # optional, lighter, good for JSON output (~9 GB)

npm ci && npm run build

# Register with Claude Code for all your projects (user scope):
claude mcp add --scope user local-worker \
  -e LOCAL_WORKER_ROOTS="/path/to/your/projects" \
  -- node /path/to/local-worker/dist/main.js
```

On Windows, `LOCAL_WORKER_ROOTS` is separated with `;`. MCP servers are discovered at
session start, so restart any open Claude Code sessions afterwards.

| Variable | Default | Meaning |
|---|---|---|
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama endpoint |
| `LOCAL_WORKER_MODEL` | `gpt-oss:20b` | Default model (`gpt-oss:20b` or `qwen3:14b`) |
| `LOCAL_WORKER_MAX_CTX` | `32768` | Largest context window requested, in tokens (bounded by VRAM) |
| `LOCAL_WORKER_ROOTS` | working dir | Directories files may be read from and written to |
| `LOCAL_WORKER_BROWSER` | Edge/Chrome/Chromium defaults | Browser executable for `render_pdf` |

Inputs larger than the context are fitted rather than rejected: small files are kept
whole, the rest of the budget is split evenly among the large ones (max-min fairness),
and each oversized file keeps its head and a larger tail, since logs usually end with
the part that matters (cuts never split a UTF-16 surrogate pair). The response says when
this happened.

## Weekly devlog

```sh
npm run devlog -- --repo owner/name [--repo owner/other] [--days 7] [--out devlog-drafts]
```

For each repo, it lists PRs merged in the last `--days` days with the GitHub CLI (`gh`,
authenticated), has the local model write a short themed log entry citing each PR as
`(#123)`, and writes `devlog-drafts/<owner>-<name>-<ISO week>.md` (the week of the local
date). Each draft starts with an HTML comment saying it's unverified, and it's flagged
automatically if the model cites a PR number that wasn't in its input or leaves out one
that was (only parenthesized `(#123)` references count, so hex colours, URL anchors and
`other/repo#12` don't), or if more than 100 PRs were merged in the window (the list is
capped, so use a smaller `--days`). Drafts are written with the same safe-write path as
the MCP tools, rooted at `--out` (re-running a week replaces that week's draft). It never pushes, comments
or opens PRs: a person (or a Claude session) checks the draft against the PRs and
publishes it.

To run it weekly on Windows:

```bat
schtasks /Create /TN "local-worker devlog" /SC WEEKLY /D FRI /ST 17:00 ^
  /TR "cmd /c cd /d C:\path\to\local-worker && npm run devlog -- --repo owner/name --out C:\path\to\devlog-drafts"
```

## Development

```sh
npm run typecheck && npm run lint && npm test && npm run build
node scripts/smoke.mjs list                     # end-to-end over stdio against the built server
node scripts/smoke.mjs local_status             # needs Ollama running
```

The unit tests cover path confinement (including symlink, junction, hard-link and `..`
escapes, files or links that change while the model runs or while a file is opened, and
the write-name rules), budget fitting edge cases,
config parsing, the Ollama client, the devlog helpers and CLI, HTML escaping in the PDF
renderer, and the MCP server end to end over an in-memory transport with a stubbed model
and printer. The smoke script is
the check against a real GPU and browser, which CI can't provide.

## License

MIT
