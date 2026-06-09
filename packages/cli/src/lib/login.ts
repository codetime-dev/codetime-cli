// Helpers for the browser-based `codetime login` (device-code flow). The
// orchestration — start, open browser, poll, persist — lives in
// loginCommand (cli.ts); this module holds the side-effecting bits
// (launching a browser, detecting headless hosts) plus a small sleep.
// The server side is codetime-web-v3/server/routes/v3/agent/cli/link/.
import type { RunContext } from './types.js'

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Best-effort launch of the user's default browser. Failures are
// swallowed: `codetime login` always prints the URL too, so a missing
// opener (headless box, locked-down container) just means the user
// opens the printed link themselves.
export function openBrowser(ctx: RunContext, url: string): void {
  const { command, args } = browserCommand(ctx.env.CODETIME_OS ?? process.platform, url)
  try {
    const child = ctx.spawn(command, args, { detached: true, stdio: 'ignore' })
    child.unref?.()
  }
  catch {
    // Ignored — the printed URL is the fallback.
  }
}

function browserCommand(platform: string, url: string): { command: string, args: string[] } {
  if (platform === 'darwin') {
    return { command: 'open', args: [url] }
  }
  if (platform === 'win32') {
    // `start` is a cmd builtin; the empty "" is the window title cmd
    // expects before the URL, otherwise a quoted URL becomes the title.
    return { command: 'cmd', args: ['/c', 'start', '', url] }
  }
  return { command: 'xdg-open', args: [url] }
}

// A headless host (CI, SSH session without X) can't open a browser; the
// caller skips the auto-open and tells the user to open the URL manually.
// Device-code login still works there — the user opens the URL on any
// other device — which is the main reason this flow exists.
export function isHeadless(ctx: RunContext): boolean {
  if (ctx.env.CODETIME_NO_BROWSER) {
    return true
  }
  if (ctx.env.SSH_CONNECTION || ctx.env.SSH_TTY) {
    return true
  }
  if (process.platform === 'linux') {
    return !ctx.env.DISPLAY && !ctx.env.WAYLAND_DISPLAY
  }
  return false
}
