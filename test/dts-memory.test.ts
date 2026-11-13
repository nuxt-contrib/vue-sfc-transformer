import type { VueDeclarationSource } from '../src/core'

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { emitVueDeclarations } from '../src/core'

setFlagsFromString('--expose-gc')
const gc = runInNewContext('gc') as () => void

async function heapUsed(): Promise<number> {
  await new Promise(resolve => setImmediate(resolve))
  // Objects embedded in optimised code are only released after several collections.
  for (let i = 0; i < 20; i++) {
    gc()
  }
  return process.memoryUsage().heapUsed
}

describe('emitVueDeclarations (memory)', () => {
  const dir = fileURLToPath(new URL('../node_modules/.tmp/dts-memory', import.meta.url))
  const types: VueDeclarationSource = { id: join(dir, 'types.ts'), source: 'export interface Item { id: string, name: string }\n' }
  const sources: VueDeclarationSource[] = [
    types,
    { id: join(dir, 'index.ts'), source: `export { default as Item0 } from './Item0.vue'\nexport const useItem = (id: string) => ({ id, name: id })\n` },
  ]
  for (let i = 0; i < 3; i++) {
    sources.push({
      id: join(dir, `Item${i}.vue`),
      source: [
        '<script setup lang="ts">',
        `import type { Item } from './types'`,
        'const props = defineProps<{ item: Item }>()',
        'const emit = defineEmits<{ select: [id: string] }>()',
        '</script>',
        `<template><button @click="emit('select', props.item.id)">{{ props.item.name }}</button></template>`,
      ].join('\n'),
    })
  }

  beforeAll(async () => {
    await rm(dir, { force: true, recursive: true })
    await mkdir(dir, { recursive: true })
    for (const { id, source } of sources) {
      await writeFile(id, source)
    }
  })
  afterAll(async () => {
    await rm(dir, { force: true, recursive: true })
  })

  async function emit(files: VueDeclarationSource[]): Promise<void> {
    const result = await emitVueDeclarations(files, { cwd: dir, cache: false })
    expect(result.diagnostics).toEqual([])
  }

  it('does not retain programs once a call returns', { timeout: 60_000 }, async () => {
    await emit([types])
    const before = await heapUsed()
    for (let i = 0; i < 4; i++) {
      await emit(sources)
    }
    expect(await heapUsed() - before).toBeLessThan(30 * 1024 * 1024)
  })
})
