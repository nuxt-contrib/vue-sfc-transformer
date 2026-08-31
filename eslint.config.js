import antfu from '@antfu/eslint-config'

export default antfu().append({
  files: ['playground/**'],
  rules: {
    'antfu/no-top-level-await': 'off',
    'no-console': 'off',
  },
}, {
  files: ['test/**'],
  rules: {
    // snapshots contain rolldown output, which is tab-indented
    'style/no-tabs': 'off',
  },
})
