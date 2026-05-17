import type { CanonicalEvent } from '@codetime/shared'

export function estimateEventCostUsd(event: CanonicalEvent): number {
  if (event.type !== 'model.usage') {
    return 0
  }
  // Use API-reported cost when available (pi, codex, etc.)
  if (typeof event.metrics?.costUsd === 'number' && event.metrics.costUsd > 0) {
    return event.metrics.costUsd
  }
  // No fallback — the API recalculates costs from stored token counts
  // using OpenRouter pricing when writing session rollups.
  return 0
}
