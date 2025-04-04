import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  externals: [
    '@vue/compiler-dom-types',
  ],
  rollup: {
    dts: {
      respectExternal: false,
    },
  },
})
