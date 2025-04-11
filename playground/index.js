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
console.log(`transpiled <template> block:`)
console.log(`\`\`\`\n<template>${templateBlockContents}</template>\n\`\`\`\n`)

// transpile script block
// notice: it is still in typescript, you need to transpile it to javascript later
const { content: scriptBlockContents } = await preTranspileScriptSetup(sfc.descriptor, 'test.vue')
console.log(`transpiled <script setup> block:`)
console.log(`\`\`\`\n<script setup lang="ts">${scriptBlockContents}</script>\n\`\`\`\n`)
