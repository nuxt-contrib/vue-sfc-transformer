import { defineConfig } from 'tsdown'

export default defineConfig({
  dts: { generator: 'oxc' },
  entry: ['src/index.ts', 'src/core.ts', 'src/mkdist.ts', 'src/rolldown.ts'],
  deps: {
    neverBundle: [
      '@vue/compiler-dom',
      'mkdist',
    ],
  },
})
