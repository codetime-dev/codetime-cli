import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- This repo uses node:test as the runner.
import { test } from 'node:test'
import { opencodeUsageFromInfo } from '../src/adapters/opencode.ts'

// ── billable-output token convention ──
//
// OpenCode reports reasoning tokens separately from output. codetime folds them
// into tokensOutput (billable output total) while keeping tokensReasoningOutput
// as the informational subset, and avoids double-counting reasoning in the total.

test('opencodeUsageFromInfo folds reasoning into billable tokensOutput', () => {
  const usage = opencodeUsageFromInfo({
    tokens: {
      input: 100,
      output: 40,
      reasoning: 15,
      cache: { read: 10, write: 5 },
    },
  })

  assert.ok(usage)
  // output (40) + reasoning (15) folded into the billable output total.
  assert.equal(usage.tokensOutput, 55)
  // reasoning stays exposed as the informational subset.
  assert.equal(usage.tokensReasoningOutput, 15)
  // tokensInput is cache-inclusive: 100 + 10 (read) + 5 (write).
  assert.equal(usage.tokensInput, 115)
  // total fallback = totalInput (115) + billableOutput (55), reasoning not added twice.
  assert.equal(usage.tokensTotal, 115 + 55)
})

test('opencodeUsageFromInfo honors an explicit upstream total', () => {
  const usage = opencodeUsageFromInfo({
    tokens: { input: 100, output: 40, reasoning: 15, total: 200, cache: { read: 0, write: 0 } },
  })

  assert.ok(usage)
  assert.equal(usage.tokensOutput, 55)
  assert.equal(usage.tokensTotal, 200)
})
