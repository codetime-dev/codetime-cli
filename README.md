# codetime

CLI for [codetime](https://codetime.dev). Detects local AI-agent installs
(Claude Code, Codex, OpenCode, Pi), installs hooks, and ships
pre-aggregated session rollups to `/v3/agent/ingest`.

## Install

```sh
npm i -g codetime-cli   # bin is `codetime`

# 1. Copy your upload token from https://codetime.dev/dashboard/settings.
# 2. Tell the CLI about it (writes ~/.codetime/config.json).
codetime token set <token>

# 3. Install integrations for whichever agents you use.
codetime detect
codetime install --target claude
```

The CLI reuses the upload token you already use for the VSCode plugin —
there's no separate "agent login". Identity is sent on each upload via
the `X-Machine-Id` header (a UUID minted once and persisted under
`~/.codetime/machine-id`).

## Packages

- `packages/cli` — the published `codetime-cli` npm package (bin: `codetime`).
- `packages/shared` — internal `@codetime/shared` types, inlined into
  the published bundle.

## Environment

| Variable | Purpose |
| --- | --- |
| `CODETIME_API_URL` | Override API host (default `https://codetime.dev`). |
| `CODETIME_TOKEN` | Bearer token (same value as the upload token in Settings). |
| `CODETIME_DEBUG` | Print verbose hook + import logs. |

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

## Publish

```sh
cd packages/cli
pnpm prepublishOnly      # bundles shared into bin/codetime.mjs
pnpm publish
```

## Commands

- `codetime detect` — list supported local targets and install status.
- `codetime install --target <id>` — install integration files.
- `codetime token set <token>` — store the upload token.
- `codetime hook --agent <name>` — read hook JSON from stdin; used by
  installed integrations, not invoked directly.
- `codetime backfill plan|import --source <id>` — import local agent
  history.
- `codetime machine ls|rename|delete` — manage registered machines.

See `packages/cli/src/cli.ts` for the full command surface.
