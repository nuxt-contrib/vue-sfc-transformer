import type { DtsCache, EmitVueDeclarationsOptions, EmitVueDeclarationsResult, VueDeclarationSource } from '../src/core'

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { emitVueDeclarations } from '../src/core'
import { loadToolchain } from '../src/dts/toolchain'

const dir = fileURLToPath(new URL('../node_modules/.tmp/dts-incremental', import.meta.url))

const COMPONENTS = 12
const COMPOSABLES = 6
const SERVER = 6

function fixture(): Record<string, string> {
  const files: Record<string, string> = {
    'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.server.json' }] }),
    'tsconfig.app.json': JSON.stringify({
      compilerOptions: { module: 'preserve', moduleDetection: 'force', lib: ['esnext', 'dom'], paths: { '#shared': ['./shared/index.ts'] } },
      include: ['app', 'shared', 'types'],
    }),
    'tsconfig.server.json': JSON.stringify({
      compilerOptions: { module: 'esnext', moduleResolution: 'bundler', lib: ['esnext'], paths: { '#shared': ['./shared/index.ts'] } },
      include: ['server', 'shared'],
    }),
    'types/globals.d.ts': `declare global {\n  interface AppInfo { name: string }\n  const useGlobalThing: typeof import('../app/composables/useThing0')['useThing0']\n}\nexport {}\n`,
    'shared/index.ts': `export * from './types'\nexport { scale } from '../vendor/scale'\n`,
    'shared/types.ts': `export interface Item { id: string, size: 'sm' | 'md' }\nexport type Size = Item['size']\n`,
    'vendor/scale/index.ts': `export const scale = 1 as const\n`,
  }
  for (let i = 0; i < COMPONENTS; i++) {
    const child = i > 0 ? `Comp${i - 1}` : undefined
    files[`app/components/Comp${i}.vue`] = [
      '<script setup lang="ts">',
      `import type { Item } from '#shared'`,
      ...child ? [`import ${child} from './${child}.vue'`] : [],
      `const props = defineProps<{ item: Item, label${i}?: string }>()`,
      `const emit = defineEmits<{ select: [id: string] }>()`,
      `defineExpose({ size: (): Item['size'] => props.item.size${i === COMPONENTS - 1 ? ', thing: () => useGlobalThing(props.item, { name: props.item.id })' : ''} })`,
      '</script>',
      `<template><button @click="emit('select', props.item.id)">${child ? `<${child} :item="props.item" />` : '{{ props.item.id }}'}</button></template>`,
    ].join('\n')
  }
  for (let i = 0; i < COMPOSABLES; i++) {
    files[`app/composables/useThing${i}.ts`] = [
      `import { scale, type Item } from '#shared'`,
      `import { computed } from 'vue'`,
      `import Comp${i * 2} from '../components/Comp${i * 2}.vue'`,
      `export function useThing${i}(item: Item, info: AppInfo) {`,
      `  return { item, size: item.size, name: computed(() => info.name), scale, component: Comp${i * 2} }`,
      '}',
      ...i === 1 ? [`export const broken: number = 'not a number'`] : [],
    ].join('\n')
  }
  files['app/composables/index.ts'] = Array.from({ length: COMPOSABLES }, (_, i) => `export * from './useThing${i}'`).join('\n')
  files['app/utils/late.ts'] = [
    `import type { Item } from '#shared'`,
    'export const late = (item: Item) => useGlobalThing(item, { name: item.id })',
    'export const info = (value: AppInfo) => ({ ...value })',
  ].join('\n')
  for (let i = 0; i < SERVER; i++) {
    files[`server/utils/util${i}.ts`] = [
      `import type { Item, Size } from '#shared'`,
      ...i > 0 ? [`import { util${i - 1} } from './util${i - 1}'`] : [],
      `export function util${i}(item: Item): { size: Size, depth: number } {`,
      `  return { size: item.size, depth: ${i > 0 ? `util${i - 1}(item).depth + 1` : '0'} }`,
      '}',
    ].join('\n')
  }
  files['server/order/a.ts'] = `export const a = (value: boolean) => value ? 'b' : 'a'\n`
  files['server/order/b.ts'] = `export const b = (value: boolean) => value ? 'a' : 'b'\n`
  return files
}

describe('emitVueDeclarations (incremental cache)', () => {
  let files: Record<string, string>

  beforeAll(async () => {
    await rm(dir, { force: true, recursive: true })
    files = fixture()
    for (const [path, source] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true })
      await writeFile(join(dir, path), source)
    }
  })
  afterAll(async () => {
    await rm(dir, { force: true, recursive: true })
  })

  const store = new Map<string, string>()
  let writes = 0
  const cache: DtsCache = {
    getItem: async key => store.get(key),
    setItem: async (key, value) => {
      writes++
      store.set(key, value)
    },
  }

  const declarations: VueDeclarationSource[] = []
  function sources(): VueDeclarationSource[] {
    return Object.entries(files)
      .filter(([path]) => !path.endsWith('.json') && !path.startsWith('types/') && !path.startsWith('vendor/'))
      .map(([path, source]) => ({ id: join(dir, path), source }))
      .concat(declarations)
  }

  async function edit(path: string, source: string | undefined): Promise<void> {
    if (source === undefined) {
      delete files[path]
      await rm(join(dir, path))
      return
    }
    files[path] = source
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), source)
  }

  const options: EmitVueDeclarationsOptions = { cwd: dir, tsconfig: 'tsconfig.json', emitLegacyDeclarationAlias: true }

  let programs = 0
  let emits = 0

  async function expectSameAsUncached(check?: (result: EmitVueDeclarationsResult) => void): Promise<number> {
    const uncached = await emitVueDeclarations(sources(), { ...options, cache: false })
    check?.(uncached)
    writes = 0
    const { performance } = loadToolchain(dir).ts as unknown as { performance: { enable: () => void, disable: () => void, getCount: (name: string) => number } }
    performance.enable()
    let result: EmitVueDeclarationsResult
    try {
      result = await emitVueDeclarations(sources(), { ...options, cache })
      programs = performance.getCount('beforeProgram')
      emits = performance.getCount('beforeEmit')
    }
    finally {
      performance.disable()
    }
    expect(result).toEqual(uncached)
    expect([...result.files.keys()]).toEqual([...uncached.files.keys()])
    return writes
  }

  it('returns the same results as an uncached run', { timeout: 120_000 }, async () => {
    const written = await expectSameAsUncached((uncached) => {
      expect(uncached.files.size).toBe((COMPONENTS * 2) + COMPOSABLES + 2 + SERVER + 2 + 2)
      expect(uncached.diagnostics.map(diagnostic => diagnostic.code)).toEqual([2322])
    })
    expect(written).toBe(COMPONENTS + COMPOSABLES + 2 + SERVER + 2 + 2 + 1)
    expect(await expectSameAsUncached()).toBe(0)
  })

  it('only emits the edited file when its declaration is unchanged', { timeout: 120_000 }, async () => {
    await edit('app/components/Comp0.vue', files['app/components/Comp0.vue']!.replace('</script>', 'const local = 1\n</script>'))
    expect(await expectSameAsUncached()).toBe(2)
    expect(programs).toBe(1)
    expect(emits).toBeLessThanOrEqual(3)
  })

  it('emits the files that depend on a changed declaration', { timeout: 120_000 }, async () => {
    await edit('app/components/Comp9.vue', files['app/components/Comp9.vue']!.replace('label9?: string', 'label9?: number'))
    const written = await expectSameAsUncached()
    expect(written).toBeGreaterThan(2)
    expect(written).toBeLessThan(COMPONENTS + COMPOSABLES)
  })

  it('emits a server file without a program for the app project', { timeout: 120_000 }, async () => {
    await edit('server/utils/util5.ts', `${files['server/utils/util5.ts']}\nconst unused = 1\n`)
    expect(await expectSameAsUncached()).toBe(2)
    expect(programs).toBe(1)
  })

  it('emits a file after the files before it, whose types can change how it is printed', { timeout: 120_000 }, async () => {
    await edit('server/order/b.ts', `${files['server/order/b.ts']}const unused = 1\n`)
    expect(await expectSameAsUncached()).toBe(2)
  })

  it('follows changes to shared types', { timeout: 120_000 }, async () => {
    await edit('shared/types.ts', files['shared/types.ts']!.replace(`'sm' | 'md'`, `'sm' | 'md' | 'lg'`))
    expect(await expectSameAsUncached()).toBeGreaterThan(COMPOSABLES)
  })

  it('follows changes to global declarations', { timeout: 120_000 }, async () => {
    await edit('types/globals.d.ts', files['types/globals.d.ts']!.replace('name: string', 'name: number'))
    await expectSameAsUncached()
  })

  it('follows changes to files imported by global declarations', { timeout: 120_000 }, async () => {
    await edit('app/composables/useThing0.ts', files['app/composables/useThing0.ts']!.replace('scale, component', 'scale, extra: 1, component'))
    expect(await expectSameAsUncached()).toBeGreaterThan(2)
  })

  it('follows declaration files added to and removed from the sources', { timeout: 120_000 }, async () => {
    const source = `declare global {\n  interface AppInfo { version: number }\n}\nexport {}\n`
    await mkdir(join(dir, 'extra'), { recursive: true })
    await writeFile(join(dir, 'extra/info.d.ts'), source)
    declarations.push({ id: join(dir, 'extra/info.d.ts'), source })
    expect(await expectSameAsUncached()).toBeGreaterThan(0)
    declarations.length = 0
    expect(await expectSameAsUncached()).toBeGreaterThan(0)
  })

  it('follows new files that change how an import resolves', { timeout: 120_000 }, async () => {
    await edit('vendor/scale.ts', `export const scale = 2 as const\n`)
    expect(await expectSameAsUncached()).toBeGreaterThan(0)
    await edit('vendor/scale.ts', undefined)
    expect(await expectSameAsUncached()).toBeGreaterThan(0)
  })

  it('follows changes to the diagnostics of a file', { timeout: 120_000 }, async () => {
    await edit('app/composables/useThing1.ts', files['app/composables/useThing1.ts']!.replace(`'not a number'`, '1'))
    await expectSameAsUncached()
    await edit('app/composables/useThing1.ts', files['app/composables/useThing1.ts']!.replace(`= 1`, `= 'one'`))
    await expectSameAsUncached()
  })
})
