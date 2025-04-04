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
