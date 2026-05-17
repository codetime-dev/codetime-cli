import { run } from './cli.js'

const code = await run(process.argv.slice(2))
process.exitCode = typeof code === 'number' ? code : 0
