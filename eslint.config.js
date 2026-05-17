import jannchie from '@jannchie/eslint-config'

export default jannchie(
  {
    vue: true,
  },
  {
    name: 'agent-time/overrides',
    rules: {
      // Conflicts with @stylistic/array-element-newline (which jannchie sets with minItems: 3 for ArrayPattern)
      'antfu/consistent-list-newline': 'off',
    },
  },
  {
    name: 'agent-time/ignores',
    ignores: [
      'packages/cli/bin/agent-time.mjs',
    ],
  },
)
