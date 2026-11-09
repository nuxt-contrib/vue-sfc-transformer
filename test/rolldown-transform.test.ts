import type { VueSfcPluginOptions } from '../src/rolldown'

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'tsdown'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { vueSfcPlugin } from '../src/rolldown'

vi.mock('rolldown/utils', () => {
  throw new Error('the `rolldown/utils` peer dependency should not be loaded')
})

const root = fileURLToPath(new URL('../node_modules/.tmp/rolldown-transform', import.meta.url))

describe('vueSfcPlugin `transform` option', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await rm(root, { force: true, recursive: true })
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src/index.ts'), 'export const x = 1\n')
    await writeFile(join(root, 'src/Hello.vue'), [
      '<script setup lang="ts">',
      'const msg: string = \'hi\'',
      'defineProps<{ name: string }>()',
      '</script>',
      '<template><div>{{ (msg as string) }}</div></template>',
    ].join('\n'))
  })
  afterAll(async () => {
    await rm(root, { force: true, recursive: true })
  })

  it('uses the provided `transform` instead of importing `rolldown/utils`', async () => {
    const { transform } = await vi.importActual<typeof import('rolldown/utils')>('rolldown/utils')
    const spy = vi.fn<NonNullable<VueSfcPluginOptions['transform']>>(transform)

    await build({
      cwd: root,
      entry: ['src/index.ts'],
      outDir: 'dist',
      logLevel: 'silent',
      plugins: [vueSfcPlugin({ srcDir: 'src', cwd: root, cache: false, transform: spy })],
    })

    expect(spy).toHaveBeenCalled()
    const output = await readFile(join(root, 'dist/Hello.vue'), 'utf8')
    expect(output).toContain('const msg = "hi"')
    expect(output).toContain('{{ msg }}')
    expect(output).not.toContain('lang="ts"')
  })

  it('falls back to the `rolldown/utils` peer dependency', async () => {
    await expect(build({
      cwd: root,
      entry: ['src/index.ts'],
      outDir: 'dist-default',
      logLevel: 'silent',
      plugins: [vueSfcPlugin({ srcDir: 'src', cwd: root, cache: false })],
    })).rejects.toThrow('should not be loaded')
  })
})
