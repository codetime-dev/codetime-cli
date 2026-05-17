import { mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const { dirname, resolve } = path

const __dirname = dirname(fileURLToPath(import.meta.url))
const outfile = resolve(__dirname, 'bin', 'codetime.mjs')
const sharedSrc = resolve(__dirname, '..', 'shared', 'src', 'index.ts')
const pkg = JSON.parse(await readFile(resolve(__dirname, 'package.json'), 'utf8'))

mkdirSync(dirname(outfile), { recursive: true })

await build({
  entryPoints: [resolve(__dirname, 'src', 'cli.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile,
  alias: {
    '@codetime/shared': sharedSrc,
  },
  define: {
    __CODETIME_CLI_VERSION__: JSON.stringify(pkg.version),
  },
  external: [
    'node:*',
  ],
  banner: {
    js: '#!/usr/bin/env node',
  },
  footer: {
    js: 'const code = await run(process.argv.slice(2));process.exitCode = code;',
  },
  minify: false,
  sourcemap: false,
  logLevel: 'info',
})

// Ensure shebang is the first line
let content = await readFile(outfile, 'utf8')
if (!content.startsWith('#!/usr/bin/env node')) {
  content = `#!/usr/bin/env node\n${content}`
  await writeFile(outfile, content, 'utf8')
}

console.log(`Bundled CLI → ${outfile}`)
