import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { parse } from 'vue/compiler-sfc'
import { vueLoader } from '../src/mkdist'

// Simulate an environment where neither optional peer transpiler is
// installed, so the loader falls back to the bundled `petrea` transpiler.
vi.mock('rolldown/utils', () => {
  throw new Error('not installed')
})
vi.mock('esbuild', () => {
  throw new Error('not installed')
})

describe('vueLoader with bundled petrea fallback', () => {
  const tmpDir = fileURLToPath(new URL('../node_modules/.tmp/fixtures-fallback', import.meta.url))

  async function fixture(src: string): Promise<string | undefined> {
    const results = await vueLoader({
      path: 'index.vue',
      srcPath: join(tmpDir, 'src/index.vue'),
      extension: '.vue',
      getContents: () => src,
    }, {
      loadFile: async () => undefined,
      options: {},
    })
    return results?.find(result => result.extension === '.vue')?.contents
  }

  it('strips script types with petrea when no external transpiler is installed', async () => {
    const contents = await fixture(`
      <script setup lang="ts">
        const msg: string = 'hello'
      </script>
    `)

    const sfc = parse(contents!, { filename: 'index.vue', ignoreEmpty: true })
    expect(sfc.descriptor.scriptSetup?.attrs).not.toHaveProperty('lang')
    expect(sfc.descriptor.scriptSetup?.content).toMatchInlineSnapshot(`
      "
              const msg         = 'hello'
      "
    `)
  })

  it('keeps template transpilation on petrea', async () => {
    const contents = await fixture(`
      <template>
        <div v-if="test as any" />
      </template>
    `)

    expect(contents).toMatchInlineSnapshot(`
      "
            <template>
              <div v-if="test as any" />
            </template>
          "
    `)
  })
})
