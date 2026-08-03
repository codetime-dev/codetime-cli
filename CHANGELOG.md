## v0.8.1

[v0.8.0...v0.8.1](https://github.com/codetime-dev/codetime-cli/compare/v0.8.0...v0.8.1)

### :adhesive_bandage: Fixes

- **cli**: stop the installed Pi extension from killing pi on startup — on Windows `codetime` is a `.cmd` shim and `spawn()` does no PATHEXT resolution, so the first report (`session_start`) raised an unhandled `ENOENT` error event and took pi down with it; the hook now runs through the shell on win32, swallows spawn/stdin errors, and unrefs the child so a long local sync no longer pins pi's event loop - By [Jianqi Pan](mailto:jannchie@gmail.com) in [362ead0](https://github.com/codetime-dev/codetime-cli/commit/362ead0)

## v0.8.0

[v0.7.7...v0.8.0](https://github.com/codetime-dev/codetime-cli/compare/v0.7.7...v0.8.0)

### :sparkles: Features

- **cli**: add Kimi Code (`~/.kimi`, `~/.kimi-code`) as a backfill source — reads both wire schemas (the newer `usage.record` lines and the older StatusUpdate payload), counts only turn-scoped records so cumulative session totals are not double-counted, and discovers `wire.jsonl` at both nesting depths - By [Jianqi Pan](mailto:jannchie@gmail.com) in [14ffec8](https://github.com/codetime-dev/codetime-cli/commit/14ffec8)

### :adhesive_bandage: Fixes

- **cli**: match a forked Codex rollout's replayed history against its parent's own usage stream instead of the same-second heuristic, which missed replays spanning several seconds and nested forks — the parent's usage (cached input especially) was being counted once per forked file (ccusage parity, #1435) - By [Jianqi Pan](mailto:jannchie@gmail.com) in [b575203](https://github.com/codetime-dev/codetime-cli/commit/b575203)
- **cli**: count Claude `advisor_message` iteration tokens — an advisor call bills at its own model's rate and is not part of the enclosing `message.usage`, so those tokens were dropped entirely (ccusage parity, #1423) - By [Jianqi Pan](mailto:jannchie@gmail.com) in [22c9f80](https://github.com/codetime-dev/codetime-cli/commit/22c9f80)
- **cli**: drop a re-emitted Codex `last_token_usage` snapshot when the cumulative `total_token_usage` did not advance — the previous dedup only caught consecutive repeats - By [Jianqi Pan](mailto:jannchie@gmail.com) in [137fe2a](https://github.com/codetime-dev/codetime-cli/commit/137fe2a)
- **cli**: bump backfill state schema to v9 so the Codex/Claude token fixes re-apply to already-uploaded history on next sync (non-destructive re-parse + replace; Codex fork-heavy history will get *smaller*, which is the correction) - By [Jianqi Pan](mailto:jannchie@gmail.com) in [ff37d6d](https://github.com/codetime-dev/codetime-cli/commit/ff37d6d)

## v0.7.7

[v0.7.6...v0.7.7](https://github.com/codetime-dev/codetime-cli/compare/v0.7.6...v0.7.7)

### :adhesive_bandage: Fixes

- **cli**: stop storing Codex `session_meta.model_provider` as the model — the provider id (`openai`, or a proxy's own name) was landing in the model leaderboard and pricing at $0; the model is now seeded from the first `turn_context`, `codex-auto-review` resolves to the review model shipping on that date (ccusage parity), and a proxy's effort parenthetical (`gpt-5.5(xhigh)`) is stripped (schema v8 re-parses history on next sync) - By [Jianqi Pan](mailto:jannchie@gmail.com)

## v0.7.6

[v0.7.5...v0.7.6](https://github.com/codetime-dev/codetime-cli/compare/v0.7.5...v0.7.6)

### :adhesive_bandage: Fixes

- **cli**: canonicalize backfill file paths via realpath so symlinked agent homes (e.g. multi-account CODEX_HOME shadows) stop uploading duplicate rollups (schema v7 re-parses history on next sync; if you use symlinked homes, run `codetime sync --purge --source <source>` once after updating to clear old duplicates) - By [Jianqi Pan](mailto:jannchie@gmail.com) in [73dba96](https://github.com/codetime-dev/codetime-cli/commit/73dba96)

## v0.7.5

[v0.7.4...v0.7.5](https://github.com/codetime-dev/codetime-cli/compare/v0.7.4...v0.7.5)

### :adhesive_bandage: Fixes

- **cli**: skip copied Codex branch rollout history via UUIDv7 creation anchor (fixes fork-file token/duration double-count; schema v6 re-parses history on next sync) - By [Jianqi Pan](mailto:jannchie@gmail.com) in [a66e2b3](https://github.com/codetime-dev/codetime-cli/commit/a66e2b3)

## v0.7.4

[v0.7.3...v0.7.4](https://github.com/codetime-dev/codetime-cli/compare/v0.7.3...v0.7.4)

### :adhesive_bandage: Fixes

- **cli**: make backfill resilient to local session-file rotation (non-destructive `--force`, opt-in `--purge`, Codex `archived_sessions` import) - By [Jianqi Pan](mailto:jannchie@gmail.com) in [b43fb61](https://github.com/codetime-dev/codetime-cli/commit/b43fb61)
- **cli**: bump backfill state schema to v5 so parity + rotation fixes re-apply to history - By [Jianqi Pan](mailto:jannchie@gmail.com) in [e906427](https://github.com/codetime-dev/codetime-cli/commit/e906427)

## v0.7.3

[v0.7.2...v0.7.3](https://github.com/codetime-dev/codetime-cli/compare/v0.7.2...v0.7.3)

### :adhesive_bandage: Fixes

- **cli**: stop double-counting OpenCode step-finish token usage - By [Jianqi Pan](mailto:jannchie@gmail.com) in [e2ddc15](https://github.com/codetime-dev/codetime-cli/commit/e2ddc15)
- **cli**: recover Amp usage from tokens.total and ledger-less threads - By [Jianqi Pan](mailto:jannchie@gmail.com) in [67c72ef](https://github.com/codetime-dev/codetime-cli/commit/67c72ef)
- **cli**: count Codex cumulative-only token_count events and clamp cached input - By [Jianqi Pan](mailto:jannchie@gmail.com) in [d39e9f1](https://github.com/codetime-dev/codetime-cli/commit/d39e9f1)
- **cli**: align pi/gemini/claude-code token edge cases with ccusage - By [Jianqi Pan](mailto:jannchie@gmail.com) in [a95cbad](https://github.com/codetime-dev/codetime-cli/commit/a95cbad)

## v0.7.2

[v0.7.1...v0.7.2](https://github.com/codetime-dev/codetime-cli/compare/v0.7.1...v0.7.2)

### :adhesive_bandage: Fixes

- **cli**: skip replayed parent token history in Codex subagent files - By [Jianqi Pan](mailto:jannchie@gmail.com) in [b85078d](https://github.com/codetime-dev/codetime-cli/commit/b85078d)

## v0.7.1

[v0.7.0...v0.7.1](https://github.com/codetime-dev/codetime-cli/compare/v0.7.0...v0.7.1)

### :adhesive_bandage: Fixes

- **cli**: prevent torn .codetime state files from bricking sync - By [Jianqi Pan](mailto:jannchie@gmail.com) in [60b6e06](https://github.com/codetime-dev/codetime-cli/commit/60b6e06)

## v0.7.0

[v0.6.0...v0.7.0](https://github.com/codetime-dev/codetime-cli/compare/v0.6.0...v0.7.0)

### :sparkles: Features

- **cli**: split cache-creation TTL and ship per-model time buckets (rollup v3) - By [Jianqi Pan](mailto:jannchie@gmail.com) in [859686a](https://github.com/codetime-dev/codetime-cli/commit/859686a)

## v0.6.0

[v0.5.0...v0.6.0](https://github.com/codetime-dev/codetime-cli/compare/v0.5.0...v0.6.0)

### :adhesive_bandage: Fixes

- **cli**: exclude idle time from turn durations and unify reasoning token accounting - By [Jianqi Pan](mailto:jannchie@gmail.com) in [de7e3be](https://github.com/codetime-dev/codetime-cli/commit/de7e3be)

## v0.5.0

[v0.4.0...v0.5.0](https://github.com/codetime-dev/codetime-cli/compare/v0.4.0...v0.5.0)

### :sparkles: Features

- **cli**: add browser-based login via device-code flow - By [Jianqi Pan](mailto:jannchie@gmail.com) in [a31c3e1](https://github.com/codetime-dev/codetime-cli/commit/a31c3e1)
- **cli**: add sync command as a shorthand for backfill import - By [Jianqi Pan](mailto:jannchie@gmail.com) in [ec29407](https://github.com/codetime-dev/codetime-cli/commit/ec29407)

## v0.4.0

[v0.3.3...v0.4.0](https://github.com/codetime-dev/codetime-cli/compare/v0.3.3...v0.4.0)

### :sparkles: Features

- **cli**: add gemini backfill support - By [Jianqi Pan](mailto:jannchie@gmail.com) in [b25e217](https://github.com/codetime-dev/codetime-cli/commit/b25e217)

## v0.3.3

[v0.3.2...v0.3.3](https://github.com/codetime-dev/codetime-cli/compare/v0.3.2...v0.3.3)

### :wrench: Chores

- **versioning**: bump version to 0.3.3 - By [Jannchie](mailto:jannchie@gmail.com) in [b8f65a1](https://github.com/codetime-dev/codetime-cli/commit/b8f65a1)

## v0.3.2

[v0.3.1...v0.3.2](https://github.com/codetime-dev/codetime-cli/compare/v0.3.1...v0.3.2)

### :adhesive_bandage: Fixes

- **backfill**: add amp backfill source support - By [Jianqi Pan](mailto:jannchie@gmail.com) in [a25dc3c](https://github.com/codetime-dev/codetime-cli/commit/a25dc3c)

## v0.3.1

[v0.3.0...v0.3.1](https://github.com/codetime-dev/codetime-cli/compare/v0.3.0...v0.3.1)

### :sparkles: Features

- **cli**: add amp backfill support and codex tier rewrite - By [Jianqi Pan](mailto:jannchie@gmail.com) in [2d4d465](https://github.com/codetime-dev/codetime-cli/commit/2d4d465)

### :adhesive_bandage: Fixes

- **ci**: avoid npm self-overwrite during publish workflow upgrade - By [Jianqi Pan](mailto:jannchie@gmail.com) in [cc12e58](https://github.com/codetime-dev/codetime-cli/commit/cc12e58)

### :wrench: Chores

- **cli**: add file logging for background errors - By [Jianqi Pan](mailto:jannchie@gmail.com) in [54bdcf1](https://github.com/codetime-dev/codetime-cli/commit/54bdcf1)
- **release**: switch release tags to v prefix - By [Jianqi Pan](mailto:jannchie@gmail.com) in [674ccf5](https://github.com/codetime-dev/codetime-cli/commit/674ccf5)

## v0.3.0

[v0.2.1...v0.3.0](https://github.com/codetime-dev/codetime-cli/compare/v0.2.1...v0.3.0)

### :sparkles: Features

- **cli**: honor agent config env overrides - By [Jianqi Pan](mailto:jannchie@gmail.com) in [d28b8ec](https://github.com/codetime-dev/codetime-cli/commit/d28b8ec)

### :adhesive_bandage: Fixes

- **cli**: dedup claude usage and reset backfill state schema - By [Jianqi Pan](mailto:jannchie@gmail.com) in [b8f5cc1](https://github.com/codetime-dev/codetime-cli/commit/b8f5cc1)

### :memo: Documentation

- update readme and publish workflow input - By [Jianqi Pan](mailto:jannchie@gmail.com) in [0292912](https://github.com/codetime-dev/codetime-cli/commit/0292912)

### :wrench: Chores

- **ci**: checkout latest release tag on manual dispatch - By [Jianqi Pan](mailto:jannchie@gmail.com) in [e80a117](https://github.com/codetime-dev/codetime-cli/commit/e80a117)

## v0.2.1

[v0.3.0...v0.2.1](https://github.com/codetime-dev/codetime-cli/compare/v0.3.0...v0.2.1)

### :adhesive_bandage: Fixes

- **ci**: avoid npm self-overwrite during publish workflow upgrade - By [Jianqi Pan](mailto:jannchie@gmail.com) in [cc12e58](https://github.com/codetime-dev/codetime-cli/commit/cc12e58)

### :wrench: Chores

- **cli**: add file logging for background errors - By [Jianqi Pan](mailto:jannchie@gmail.com) in [54bdcf1](https://github.com/codetime-dev/codetime-cli/commit/54bdcf1)
- **release**: switch release tags to v prefix - By [Jianqi Pan](mailto:jannchie@gmail.com) in [674ccf5](https://github.com/codetime-dev/codetime-cli/commit/674ccf5)

## v0.3.0

[v0.2.1...v0.3.0](https://github.com/codetime-dev/codetime-cli/compare/v0.2.1...v0.3.0)

### :sparkles: Features

- **cli**: honor agent config env overrides - By [Jianqi Pan](mailto:jannchie@gmail.com) in [d28b8ec](https://github.com/codetime-dev/codetime-cli/commit/d28b8ec)

### :adhesive_bandage: Fixes

- **cli**: dedup claude usage and reset backfill state schema - By [Jianqi Pan](mailto:jannchie@gmail.com) in [b8f5cc1](https://github.com/codetime-dev/codetime-cli/commit/b8f5cc1)

### :memo: Documentation

- update readme and publish workflow input - By [Jianqi Pan](mailto:jannchie@gmail.com) in [0292912](https://github.com/codetime-dev/codetime-cli/commit/0292912)

### :wrench: Chores

- **ci**: checkout latest release tag on manual dispatch - By [Jianqi Pan](mailto:jannchie@gmail.com) in [e80a117](https://github.com/codetime-dev/codetime-cli/commit/e80a117)

## v0.2.1

[v0.2.0...v0.2.1](https://github.com/codetime-dev/codetime-cli/compare/v0.2.0...v0.2.1)

### :art: Refactors

- **cli**: restructure backfill import flow - By [Jianqi Pan](mailto:jannchie@gmail.com) in [d38a222](https://github.com/codetime-dev/codetime-cli/commit/d38a222)

### :construction_worker: CI

- **github-actions**: add npm publish workflow - By [Jianqi Pan](mailto:jannchie@gmail.com) in [8cab4a2](https://github.com/codetime-dev/codetime-cli/commit/8cab4a2)

### :wrench: Chores

- **cli**: update repository metadata - By [Jianqi Pan](mailto:jannchie@gmail.com) in [2631b76](https://github.com/codetime-dev/codetime-cli/commit/2631b76)
- **deps**: bump pnpm and lockfile - By [Jianqi Pan](mailto:jannchie@gmail.com) in [e556411](https://github.com/codetime-dev/codetime-cli/commit/e556411)

## v0.2.0

codetime@0.1.0...v0.2.0

### :sparkles: Features

- **cli**: add byte-bounded backfill batching - By [Jianqi Pan](mailto:jannchie@gmail.com) in 302859d

## codetime@0.1.0

712653015554bb39dd5520e3ec20ec06a24c9724...codetime@0.1.0

### :test_tube: Tests

- **shared**: switch schema tests to node test - By [Jianqi Pan](mailto:jannchie@gmail.com) in 2772e19

### :wrench: Chores

- **cli**: rename cli package references - By [Jianqi Pan](mailto:jannchie@gmail.com) in 978ab8a
- **release**: add release helper scripts - By [Jianqi Pan](mailto:jannchie@gmail.com) in 20beb7c
