# vue-sfc-transformer

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![Github Actions][github-actions-src]][github-actions-href]
[![Codecov][codecov-src]][codecov-href]

> Tools for minimal TypeScript transpilation of Vue SFCs

## Usage

Install package:

```sh
# npm
npm install vue-sfc-transformer vue @vue/compiler-core esbuild

# pnpm
pnpm install vue-sfc-transformer vue @vue/compiler-core esbuild
```

```js
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

const sfc = parseSFC(src, {
  filename: 'test.vue',
  ignoreEmpty: true,
})

// transpile template block
const templateBlockContents = await transpileVueTemplate(
  sfc.descriptor.template.content,
  sfc.descriptor.template.ast,
  sfc.descriptor.template.loc.start.offset,
  async (code) => {
    const res = await transform(code, { loader: 'ts', target: 'esnext' })
    return res.code
  },
)
console.log(templateBlockContents)
// <div v-if="test" />

const { content: scriptBlockContents } = await preTranspileScriptSetup(sfc.descriptor, 'test.vue')
console.log(scriptBlockContents)
// defineProps({
//   test: { type: String, required: false }
// })
```

If you are using `mkdist`, `vue-sfc-transformer` exports a loader you can use:

```ts
import { vueLoader } from 'vue-sfc-transformer/mkdist'
```

> `mkdist` will automatically use the loader from `vue-sfc-transformer` when you pass `vue` to the `loaders` option and have this package installed.

## Rolldown plugin

`vue-sfc-transformer/rolldown` ships a [rolldown](https://github.com/rolldown/rolldown) plugin that transpiles `<script lang="ts">` and template expressions, then emits a `<name>.d.vue.ts` declaration for each SFC under `srcDir`. That's the form `vue-tsc` / `@vue/language-core` / `@volar/typescript` (since 2.4.19) resolve for `import './Foo.vue'`. Pass `emitLegacyDeclarationAlias: true` to also emit the older `<name>.vue.d.ts` form, which plain `tsc` resolves but vue-tsc does not.

Works with anything that runs rolldown plugins: [tsdown](https://github.com/rolldown/tsdown), [obuild](https://github.com/unjs/obuild) or rolldown directly.

```sh
pnpm add -D rolldown @volar/typescript @vue/language-core typescript
```

```ts
// tsdown.config.ts
import { defineConfig } from 'tsdown'
import { vueSfcPlugin } from 'vue-sfc-transformer/rolldown'

export default defineConfig({
  entry: ['src/index.ts'],
  plugins: [vueSfcPlugin({ srcDir: 'src' })],
})
```

Declarations are cached on disk under `<cwd>/node_modules/.cache/vue-sfc-dts/`, keyed by a content hash that incorporates the SFC source, the installed versions of `vue-sfc-transformer` / `@vue/language-core` / `@volar/typescript` / `typescript`, and a hash of the resolved `vueCompilerOptions`. The TS program is by far the dominant build cost; a full cache hit skips it entirely.

Pass `cache: false` to disable. Pass `cacheVersion: '<your-string>'` to namespace the cache under your control on top of the auto-derivation.

The `cache` option is structurally compatible with the `getItem` / `setItem` subset of [unstorage](https://github.com/unjs/unstorage)'s `Storage`, so you can hand it an unstorage instance directly:

```ts
import { createStorage } from 'unstorage'
import redisDriver from 'unstorage/drivers/redis'
import { vueSfcPlugin } from 'vue-sfc-transformer/rolldown'

vueSfcPlugin({
  srcDir: 'src',
  cache: createStorage({ driver: redisDriver({ url: 'redis://…' }) }),
})
```

## 💻 Development

- Clone this repository
- Enable [Corepack](https://github.com/nodejs/corepack) using `corepack enable`
- Install dependencies using `pnpm install`
- Run interactive tests using `pnpm dev`

## Credits

This package was based on the work of contributors to [`mkdist`](https://github.com/unjs/mkdist), and in particular this PR by [**@Teages**](https://github.com/teages): [unjs/mkdist#300](https://github.com/unjs/mkdist/pull/300).

## License

Made with ❤️

Published under [MIT License](./LICENCE).

<!-- Badges -->

[npm-version-src]: https://npmx.dev/api/registry/badge/version/vue-sfc-transformer
[npm-version-href]: https://npmx.dev/package/vue-sfc-transformer
[npm-downloads-src]: https://npmx.dev/api/registry/badge/downloads/vue-sfc-transformer
[npm-downloads-href]: https://npm.chart.dev/vue-sfc-transformer
[github-actions-src]: https://img.shields.io/github/actions/workflow/status/nuxt-contrvue-sfc-transformerransformer/ci.yml?branch=main&style=flat-square
[github-actions-href]: https://github.com/nuxt-contrvue-sfc-transformerransformer/actions?query=workflow%3Aci
[codecov-src]: https://img.shields.io/codecov/c/gh/nuxt-contrvue-sfc-transformerransformer/main?style=flat-square
[codecov-href]: https://codecov.io/gh/nuxt-contrvue-sfc-transformerransformer
