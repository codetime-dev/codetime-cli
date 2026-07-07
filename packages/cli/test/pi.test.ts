import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- This repo uses node:test as the runner.
import { test } from 'node:test'
import { piUsageFromMessage } from '../src/adapters/pi.ts'

// pi mirrors ccusage apply_total_token_fallback: an explicit totalTokens can only
// ADD tokens the itemized parts don't account for, never shrink the parts sum.

test('parity: ccusage pi falls_back_to_total_tokens_when_pi_parts_are_missing', () => {
  // usage with only totalTokens → the whole total is folded into billable output.
  const usage = piUsageFromMessage({ usage: { totalTokens: 333 } })

  assert.ok(usage)
  assert.equal(usage.tokensOutput, 333)
  assert.equal(usage.tokensTotal, 333)
})

test('pi never lets an explicit total shrink the parts sum', () => {
  // totalTokens (150) is smaller than input+output+cacheRead (2150) — e.g. a total
  // computed excluding cache. The grand total must not undercount the parts.
  const usage = piUsageFromMessage({ usage: { input: 100, output: 50, cacheRead: 2000, totalTokens: 150 } })

  assert.ok(usage)
  // cache-inclusive input: 100 + 2000.
  assert.equal(usage.tokensInput, 2100)
  assert.equal(usage.tokensOutput, 50)
  assert.equal(usage.tokensTotal, 2150) // max(explicit 150, parts 2150)
})

test('pi still passes through a consistent explicit total', () => {
  const usage = piUsageFromMessage({ usage: { input: 100, output: 50, totalTokens: 200 } })

  assert.ok(usage)
  assert.equal(usage.tokensInput, 100)
  assert.equal(usage.tokensOutput, 100) // 50 + (200 - 150) folded
  assert.equal(usage.tokensTotal, 200)
})
