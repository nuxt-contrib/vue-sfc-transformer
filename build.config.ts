import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  declaration: 'node16',
  externals: [
    '@vue/compiler-dom',
  ],
  rollup: {
    dts: {
      respectExternal: false,
    },
  },
})
