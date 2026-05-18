<div align="center">

<img src="https://codetime.dev/icon.svg" alt="codetime" width="96" height="96" />

# codetime-cli

**Track AI-agent coding time across Claude Code, Codex, OpenCode, and Pi.**

[![npm](https://img.shields.io/npm/v/codetime-cli?color=1874A8&label=npm)](https://www.npmjs.com/package/codetime-cli)
[![license](https://img.shields.io/npm/l/codetime-cli?color=1874A8)](./packages/cli/package.json)
[![node](https://img.shields.io/node/v/codetime-cli?color=1874A8)](https://nodejs.org)

[codetime.dev](https://codetime.dev) · [Dashboard](https://codetime.dev/dashboard) · [Issues](https://github.com/codetime-dev/codetime-cli/issues)

</div>

---

The official CLI for [codetime](https://codetime.dev). It detects local
AI-agent installs, wires up their hooks, and ships pre-aggregated session
rollups to `/v3/agent/ingest` — so the same dashboard that tracks your
editor time also tracks your agent time.

> Privacy: only **metadata** leaves your machine. Prompt text, command
> output, source code, and diffs are never imported or uploaded.
> See [Privacy & data collected](#privacy--data-collected) for the full
> field-level breakdown.

## Features

- **Zero-config detection** — `codetime detect` finds installed agents.
- **Hook installation** — one command wires each agent's hook into codetime.
- **History backfill** — import past sessions from local JSONL transcripts.
- **Incremental sync** — watermarked, throttled, runs in the background.
- **Multi-machine** — every host is a named machine in your dashboard.
- **Token reuse** — same upload token as the VSCode plugin; no extra login.

## Supported agents

| Agent | id | Source |
| --- | --- | --- |
| Claude Code | `claude` | `~/.claude/projects/**` |
| Codex CLI | `codex` | `~/.codex/sessions/**` |
| OpenCode | `opencode` | `~/.local/share/opencode/**` |
| Pi | `pi` | `~/.pi/sessions/**` |
| Amp | `amp` | `~/.local/share/amp/threads/**` (backfill only) |

## Install

```sh
npm i -g codetime-cli   # bin: `codetime`
```

Requires Node.js ≥ 20.

## Quick start

```sh
# 1. Copy your upload token from https://codetime.dev/dashboard/settings
codetime token set <token>

# 2. See which agents are installed locally
codetime detect

# 3. Wire up the hooks (auto-detects, or pass --target / --all)
codetime install

# 4. (Optional) Backfill past sessions
codetime backfill import --source all
```

Identity is sent on each upload via the `X-Machine-Id` header — a UUID
minted once and persisted at `~/.codetime/machine-id`. Rename machines
from `codetime machine rename --name "..."` or the dashboard.

## Commands

| Command | Purpose |
| --- | --- |
| `codetime detect` | List supported targets and install status. |
| `codetime install [--target <id>] [--all] [--force] [--dry-run]` | Install hooks into detected or requested targets. |
| `codetime backfill <plan\|import\|discover\|verify> [--source <id>] [--since] [--until] [--project] [--force]` | Import local agent history. |
| `codetime token <set\|show\|clear>` | Manage the upload token (stored in `~/.codetime/config.json`). |
| `codetime machine <ls\|rename\|delete>` | Manage registered machines. |
| `codetime hook --agent <name>` | Internal — invoked by installed hook files. |
| `codetime version` / `codetime help` | Self-explanatory. |

Add `--json` to most commands for machine-readable output, or `--dry-run`
to preview without writing or uploading.

## Privacy & data collected

codetime-cli is **metadata-only**. We never read or upload the contents
of your code, prompts, or tool output. Below is the exact set of fields
that leave your machine.

### What IS collected

**Identity & host**

- Machine UUID (`~/.codetime/machine-id`), hostname, OS platform, and
  the display name you set via `codetime machine rename`.
- Your upload token, sent as `Authorization: Bearer` on every request.

**Session shape** (per agent session)

- Agent name (`claude` / `codex` / `opencode` / `pi` / `amp`), session id,
  turn ids, timestamps, durations.
- Workspace / project name — typically the basename of the working
  directory the agent was launched in (e.g. `codetime-cli`).
- The working directory **path** (`cwd`) and a derived `workspaceId`
  hash. Absolute paths may include your username (e.g.
  `/home/alice/work/myproject`).
- Model identifiers (e.g. `claude-opus-4-7`) and per-model call counts.
- Tool names invoked (e.g. `Bash`, `Edit`, `Read`) and how often they
  ran or failed — **never the arguments or results**.
- Token usage: input / output / cache / reasoning, plus estimated cost.
- Prompt **character count** per turn (not the prompt text).

**File activity** (per touched file)

- File path within the workspace (e.g. `src/cli.ts`) and a stable
  `pathHash` — useful for dashboards that group by file.
- File language, kind (`source` / `test` / `config` / `docs` / `data`),
  bytes / chars / lines **read / added / removed** — counts only.

### What is NEVER collected

- ❌ Source code, file contents, or diffs.
- ❌ Prompt text, assistant replies, system prompts, or any chat
  message bodies.
- ❌ Shell command text, command output, or stdout / stderr.
- ❌ Tool-call arguments or tool-call responses.
- ❌ Environment variables, secrets, tokens, or API keys.
- ❌ Filesystem contents outside the agent's session transcripts.
- ❌ Browser history, clipboard, keystrokes, screenshots, microphone,
  camera — none of that is touched.

### Verify it yourself

Every command supports a dry-run that prints the exact payload without
sending it:

```sh
codetime backfill plan --source all --json        # see planned events
codetime backfill import --source all --dry-run   # see, don't upload
echo '{}' | codetime hook --agent claude --dry-run
```

Source of truth for the wire format: `packages/shared/src/index.ts`
(`CanonicalEvent`, `SessionRollup`, `FileActivityRecord`). If a field
isn't in those interfaces, it isn't uploaded.

### Controls

- Stop uploading: `codetime token clear` removes the token; hooks
  become no-ops without one.
- Remove an existing machine and its rollups: `codetime machine delete --id <id>`.
- Uninstall hooks: remove the files listed by `codetime detect`, or
  delete the codetime block from your agent's settings.
- Self-host: point `CODETIME_API_URL` at your own ingest server.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `CODETIME_API_URL` | Override API host. | `https://codetime.dev` |
| `CODETIME_TOKEN` | Bearer token (same value as the upload token). | — |
| `CODETIME_DEBUG` | Print verbose hook + import logs. | — |

Token precedence (highest first): `--token` flag → `CODETIME_TOKEN` env →
saved config in `~/.codetime/config.json`.

## Repository layout

- `packages/cli` — the published `codetime-cli` npm package.
- `packages/shared` — internal `@codetime/shared` types, inlined at build.

## Development

```sh
pnpm install
pnpm build
pnpm test
```

Point the CLI at a local codetime dev server:

```sh
CODETIME_API_URL=http://localhost:3002 \
  tsx packages/cli/src/main.ts detect
```

Link the in-repo build globally:

```sh
pnpm hooks:link        # build + link as `codetime`
pnpm hooks:unlink      # undo
```

## Publish

```sh
cd packages/cli
pnpm prepublishOnly      # bundles shared into bin/codetime.mjs
pnpm publish
```

See `scripts/release.sh` for the automated release flow (`pnpm release`).

## License

[MIT](./packages/cli/package.json) © codetime
