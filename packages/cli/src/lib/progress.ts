/**
 * Lightweight terminal progress bar using ANSI escape codes.
 * Supports a single active bar at a time; calling `update()` redraws the line.
 */

import type { WritableLike } from './types.js'

const BAR_WIDTH = 24

export class ProgressBar {
  private readonly stream: WritableLike
  private label: string
  private current = 0
  private total = 0
  private tail = ''
  private started = false
  private done = false

  constructor(stream: WritableLike, label: string) {
    this.stream = stream
    this.label = label
  }

  /**
   * Initialise or reset the bar. Must be called before first `update()`.
   * When `total` is 0 the bar is indeterminate (spinning).
   */
  init(total: number, tail = ''): void {
    this.current = 0
    this.total = total
    this.tail = tail
    this.started = true
    this.done = false
    this.draw()
  }

  /**
   * Advance by one and redraw. Call `finalize()` when done.
   */
  tick(tail?: string): void {
    if (!this.started || this.done) {
      return
    }
    this.current += 1
    if (tail !== undefined) {
      this.tail = tail
    }
    this.draw()
  }

  /**
   * Update current count and redraw.
   */
  update(current: number, tail?: string): void {
    if (!this.started || this.done) {
      return
    }
    this.current = current
    if (tail !== undefined) {
      this.tail = tail
    }
    this.draw()
  }

  /**
   * Set label text.
   */
  setLabel(label: string): void {
    this.label = label
    if (this.started && !this.done) {
      this.draw()
    }
  }

  /**
   * Mark the bar as complete and print a finalised line.
   */
  finalize(tail?: string): void {
    if (!this.started || this.done) {
      return
    }
    this.done = true
    this.stream.write(
      `\r${this.label} ${renderBar(1)} 100% · ${tail ?? this.tail}\n`,
    )
  }

  /**
   * Clear the bar line without outputting anything.
   */
  clear(): void {
    if (this.started && !this.done) {
      this.stream.write('\r\u001B[K')
      this.started = false
    }
  }

  private draw(): void {
    const pct = this.total > 0 ? this.current / this.total : 0
    this.stream.write(
      `\r${this.label} ${renderBar(pct)} ${fmtPct(pct)} · ${this.tail}`,
    )
  }
}

function renderBar(fraction: number): string {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * BAR_WIDTH)
  const empty = BAR_WIDTH - filled
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`
}

function fmtPct(fraction: number): string {
  return `${(fraction * 100).toFixed(0)}%`.padStart(4)
}
