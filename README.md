# vue-sfc-transformer

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![Github Actions][github-actions-src]][github-actions-href]
[![Codecov][codecov-src]][codecov-href]

> Package description

## Usage

Install package:

```sh
# npm
npm install vue-sfc-transformer

# pnpm
pnpm install vue-sfc-transformer
```

```js
import { parse as parseDOM } from '@vue/compiler-dom'
import { parse as parseSFC } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

import { preTranspileScriptSetup, transpileVueTemplate } from 'vue-sfc-transformer'

const src = `
<template>
  <div v-if="test as any" />
</template>

<script setup lang="ts">
defineProps<{
  test?: string
}>()
</script>
`

const transpiledTemplate = await transpileVueTemplate(
  src,
  parseDOM(src, { parseMode: 'base' }),
  0,
  async (code) => {
    const res = await transform(code, { loader: 'ts', target: 'esnext' })
    return res.code
  },
)

console.log(transpiledTemplate)

const sfc = parseSFC(transpiledTemplate, {
  filename: 'test.vue',
  ignoreEmpty: true,
})

const { content: scriptBlockContents } = await preTranspileScriptSetup(sfc.descriptor, 'test.vue')
console.log(scriptBlockContents)
```

## 💻 Development

- Clone this repository
- Enable [Corepack](https://github.com/nodejs/corepack) using `corepack enable`
- Install dependencies using `pnpm install`
- Run interactive tests using `pnpm dev`

## License

Made with ❤️

Published under [MIT License](./LICENCE).

<!-- Badges -->

[npm-version-src]: https://img.shields.io/npm/v/vue-sfc-transformer?style=flat-square
[npm-version-href]: https://npmjs.com/package/vue-sfc-transformer
[npm-downloads-src]: https://img.shields.io/npm/dm/vue-sfc-transformer?style=flat-square
[npm-downloads-href]: https://npm.chart.dev/vue-sfc-transformer
[github-actions-src]: https://img.shields.io/github/actions/workflow/status/nuxt-contrvue-sfc-transformerransformer/ci.yml?branch=main&style=flat-square
[github-actions-href]: https://github.com/nuxt-contrvue-sfc-transformerransformer/actions?query=workflow%3Aci
[codecov-src]: https://img.shields.io/codecov/c/gh/nuxt-contrvue-sfc-transformerransformer/main?style=flat-square
[codecov-href]: https://codecov.io/gh/nuxt-contrvue-sfc-transformerransformer
