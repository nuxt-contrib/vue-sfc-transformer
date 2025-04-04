import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  declaration: 'node16',
  externals: [
    '@vue/compiler-dom',
    'mkdist',
  ],
  rollup: {
    dts: {
      respectExternal: false,
    },
  },
})
