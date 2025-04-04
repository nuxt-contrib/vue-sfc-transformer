import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  declaration: 'node16',
  externals: [
    '@vue/compiler-dom-types',
  ],
  rollup: {
    dts: {
      respectExternal: false,
    },
  },
})
