import { defineConfig } from 'tsdown'

export default defineConfig({
  dts: { oxc: true },
  entry: ['src/index.ts', 'src/mkdist.ts', 'src/rolldown.ts'],
  deps: {
    neverBundle: [
      '@vue/compiler-dom',
      'mkdist',
    ],
  },
})
