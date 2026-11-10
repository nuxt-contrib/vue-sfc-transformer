import type { DtsCache } from '../src/dts/cache'
import type { EmitVueDeclarationsOptions, VueTscRunner } from '../src/dts/emit'

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createFileSystemDtsCache } from '../src/dts/cache'
import { emitVueDeclarations } from '../src/dts/emit'

describe('emitVueDeclarations (caching)', () => {
  const dir = fileURLToPath(new URL('../node_modules/.tmp/dts-emit', import.meta.url))

  beforeAll(async () => {
    await rm(dir, { force: true, recursive: true })
    await mkdir(dir, { recursive: true })
  })
  afterAll(async () => {
    await rm(dir, { force: true, recursive: true })
  })

  function fakeRunner(map: Record<string, string> = {}): VueTscRunner {
    return (files) => {
      const out = new Map<string, string>()
      for (const f of files) {
        out.set(f.id, map[f.id] ?? `declare const _${f.id.length}: ${JSON.stringify(f.source)}\n`)
      }
      return out
    }
  }

  it('returns empty for empty input', async () => {
    const opts: EmitVueDeclarationsOptions = { rootDir: dir }
    const result = await emitVueDeclarations([], opts)
    expect(result.size).toBe(0)
  })

  it('caches without a user-supplied `cacheVersion` (auto-derived) when a `cache` is explicitly provided', async () => {
    const cacheDir = join(dir, 'auto-version')
    const cache = createFileSystemDtsCache({ dir: cacheDir })
    const runner = vi.fn(fakeRunner({ '/auto.vue': 'declare const A: 1\n' }))
    const files = [{ id: '/auto.vue', source: 'auto' }]

    const first = await emitVueDeclarations(files, { rootDir: dir, cache, runner })
    expect(runner).toHaveBeenCalledTimes(1)
    expect(first.get('/auto.vue')).toBe('declare const A: 1\n')

    const second = await emitVueDeclarations(files, { rootDir: dir, cache, runner })
    expect(runner).toHaveBeenCalledTimes(1)
    expect(second.get('/auto.vue')).toBe('declare const A: 1\n')
  })

  it('skips caching entirely when `cache: false`', async () => {
    const runner = vi.fn(fakeRunner({ '/a.vue': 'declare const A: 1\n' }))
    const result = await emitVueDeclarations(
      [{ id: '/a.vue', source: '<template/>' }],
      { rootDir: dir, cache: false, runner },
    )
    expect(runner).toHaveBeenCalledTimes(1)
    expect(result.get('/a.vue')).toBe('declare const A: 1\n')

    const second = await emitVueDeclarations(
      [{ id: '/a.vue', source: '<template/>' }],
      { rootDir: dir, cache: false, runner },
    )
    expect(runner).toHaveBeenCalledTimes(2)
    expect(second.get('/a.vue')).toBe('declare const A: 1\n')
  })

  it('uses a default fs cache under `<rootDir>/node_modules/.cache/vue-sfc-dts` when none is supplied', async () => {
    const rootDir = join(dir, 'default-cache-root')
    await mkdir(rootDir, { recursive: true })
    const runner = vi.fn(fakeRunner({ '/d.vue': 'declare const D: 1\n' }))
    const files = [{ id: '/d.vue', source: 'default-cache' }]

    const first = await emitVueDeclarations(files, { rootDir, runner })
    expect(runner).toHaveBeenCalledTimes(1)
    expect(first.get('/d.vue')).toBe('declare const D: 1\n')

    const second = await emitVueDeclarations(files, { rootDir, runner })
    expect(runner).toHaveBeenCalledTimes(1)
    expect(second.get('/d.vue')).toBe('declare const D: 1\n')
  })

  it('writes to the cache on a miss and reads on a subsequent hit', async () => {
    const cacheDir = join(dir, 'miss-then-hit')
    const cache: DtsCache = createFileSystemDtsCache({ dir: cacheDir })
    const runner = vi.fn(fakeRunner({ '/m.vue': 'declare const M: 1\n' }))
    const files = [{ id: '/m.vue', source: '<template>m</template>' }]
    const opts = { rootDir: dir, cache, cacheVersion: 'v1', runner }

    const first = await emitVueDeclarations(files, opts)
    expect(runner).toHaveBeenCalledTimes(1)
    expect(first.get('/m.vue')).toBe('declare const M: 1\n')

    const second = await emitVueDeclarations(files, opts)
    expect(runner).toHaveBeenCalledTimes(1)
    expect(second.get('/m.vue')).toBe('declare const M: 1\n')
  })

  it('bypasses the cache when cacheVersion changes', async () => {
    const cacheDir = join(dir, 'version-bump')
    const cache = createFileSystemDtsCache({ dir: cacheDir })
    const runner = vi.fn(fakeRunner({ '/v.vue': 'declare const V: 1\n' }))
    const files = [{ id: '/v.vue', source: '<template>v</template>' }]

    await emitVueDeclarations(files, { rootDir: dir, cache, cacheVersion: 'v1', runner })
    expect(runner).toHaveBeenCalledTimes(1)

    await emitVueDeclarations(files, { rootDir: dir, cache, cacheVersion: 'v2', runner })
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('only re-runs the runner for cache misses on partial hits', async () => {
    const cacheDir = join(dir, 'partial')
    const cache = createFileSystemDtsCache({ dir: cacheDir })
    const runner = vi.fn(fakeRunner())
    const a = { id: '/a.vue', source: 'A' }
    const b = { id: '/b.vue', source: 'B' }

    await emitVueDeclarations([a], { rootDir: dir, cache, cacheVersion: 'v1', runner })
    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner.mock.calls[0]?.[0]).toEqual([a])

    runner.mockClear()
    const both = await emitVueDeclarations([a, b], { rootDir: dir, cache, cacheVersion: 'v1', runner })
    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner.mock.calls[0]?.[0]).toEqual([b])
    expect(both.size).toBe(2)
  })

  // Models the shape returned by unstorage's `createStorage()`: async
  // `getItem` returning `null` on miss, `setItem` returning `void`.
  it('accepts a cache that uses the unstorage-style `null` miss convention', async () => {
    const store = new Map<string, string>()
    const cache: DtsCache = {
      async getItem(key) {
        return store.has(key) ? store.get(key)! : null
      },
      async setItem(key, value) {
        store.set(key, value)
      },
    }
    const runner = vi.fn(fakeRunner({ '/u.vue': 'declare const U: 1\n' }))
    const files = [{ id: '/u.vue', source: 'u' }]

    const first = await emitVueDeclarations(files, { rootDir: dir, cache, runner })
    expect(runner).toHaveBeenCalledTimes(1)
    expect(first.get('/u.vue')).toBe('declare const U: 1\n')
    expect(store.size).toBe(1)

    const second = await emitVueDeclarations(files, { rootDir: dir, cache, runner })
    expect(runner).toHaveBeenCalledTimes(1)
    expect(second.get('/u.vue')).toBe('declare const U: 1\n')
  })
})

describe('emitVueDeclarations (vue-tsc end-to-end)', () => {
  const dir = fileURLToPath(new URL('../node_modules/.tmp/dts-emit-real', import.meta.url))

  beforeAll(async () => {
    await rm(dir, { force: true, recursive: true })
    await mkdir(dir, { recursive: true })
  })
  afterAll(async () => {
    await rm(dir, { force: true, recursive: true })
  })

  it('emits a declaration for a real .vue fixture', { timeout: 50_000 }, async () => {
    const id = join(dir, 'Hello.vue')
    const source = `<script setup lang="ts">defineProps<{ msg: string }>()</script><template><div>{{ msg }}</div></template>`
    await writeFile(id, source)
    const result = await emitVueDeclarations([{ id, source }], { rootDir: dir, cache: false })
    const dts = result.get(id)
    expect(dts).toBeDefined()
    expect(dts).toContain('msg')
    expect(dts).toContain('DefineComponent')
  })

  it('emits a declaration for an SFC with a side-effect stylesheet import', { timeout: 50_000 }, async () => {
    const id = join(dir, 'Styled.vue')
    const source = `<script setup lang="ts">import './styled.css'\ndefineProps<{ msg: string }>()</script><template><div>{{ msg }}</div></template>`
    await writeFile(id, source)
    const result = await emitVueDeclarations([{ id, source }], { rootDir: dir, cache: false })
    expect(result.get(id)).toContain('msg')
  })

  it('resolves path aliases from tsconfig.compilerOptions.paths in emitted declarations', { timeout: 50_000 }, async () => {
    const root = join(dir, 'paths-test')
    await mkdir(root, { recursive: true })

    await writeFile(join(root, 'button-types.ts'), `export interface ButtonProps { label: string }\n`)

    const tsconfigPath = join(root, 'tsconfig.json')
    await writeFile(tsconfigPath, JSON.stringify({
      compilerOptions: {
        paths: { '#button': ['./button-types.ts'] },
      },
    }))

    const id = join(root, 'Button.vue')
    const source = [
      `<script setup lang="ts">`,
      `import type { ButtonProps } from '#button'`,
      `defineProps<ButtonProps>()`,
      `</script>`,
      `<template><slot /></template>`,
    ].join('\n')
    await writeFile(id, source)

    const result = await emitVueDeclarations([{ id, source }], {
      rootDir: root,
      tsconfig: tsconfigPath,
      cache: false,
    })

    const dts = result.get(id)
    expect(dts).toBeDefined()
    expect(dts).toContain('ButtonProps')
  })

  it('ignores errors in files other than the emitted SFCs', { timeout: 50_000 }, async () => {
    const root = join(dir, 'unrelated-errors')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'types.ts'), [
      'export interface Props { msg: string }',
      'export const broken: number = \'not a number\'',
    ].join('\n'))

    const id = join(root, 'Hello.vue')
    const source = `<script setup lang="ts">import type { Props } from './types'\ndefineProps<Props>()</script><template><div>{{ msg }}</div></template>`
    await writeFile(id, source)

    const result = await emitVueDeclarations([{ id, source }], { rootDir: root, cache: false })
    expect(result.get(id)).toContain('Props')
  })

  it('fails when TypeScript reports declaration emit diagnostics', { timeout: 50_000 }, async () => {
    const root = join(dir, 'diagnostics-test')
    await mkdir(root, { recursive: true })

    const id = join(root, 'BrokenTypes.vue')
    const source = [
      `<script setup lang="ts">`,
      `import type { MissingProps } from '#missing'`,
      `defineProps<MissingProps>()`,
      `</script>`,
      `<template><slot /></template>`,
    ].join('\n')
    await writeFile(id, source)

    await expect(emitVueDeclarations([{ id, source }], {
      rootDir: root,
      cache: false,
    })).rejects.toThrow(/Cannot find module|#missing|diagnostic/i)
  })
})

describe('emitVueDeclarations (project tsconfig)', () => {
  const dir = fileURLToPath(new URL('../node_modules/.tmp/dts-emit-project', import.meta.url))

  beforeAll(async () => {
    await rm(dir, { force: true, recursive: true })
  })
  afterAll(async () => {
    await rm(dir, { force: true, recursive: true })
  })

  async function emitFixture(name: string, files: Record<string, string>, paths?: (root: string) => Record<string, string[]>): Promise<string | undefined> {
    const root = join(dir, name)
    for (const [path, contents] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), contents)
    }
    const id = join(root, 'src/Component.vue')
    const result = await emitVueDeclarations([{ id, source: files['src/Component.vue']! }], {
      rootDir: root,
      tsconfig: join(root, 'tsconfig.json'),
      paths: paths?.(root),
      cache: false,
    })
    return result.get(id)
  }

  const usesAmbientType = [
    '<script setup lang="ts">',
    'defineProps<{ size: AmbientSize }>()',
    '</script>',
    '<template><div /></template>',
  ].join('\n')

  it('includes ambient declarations from the tsconfig `include`', { timeout: 50_000 }, async () => {
    const dts = await emitFixture('ambient', {
      'tsconfig.json': JSON.stringify({ include: ['src', 'types'] }),
      'types/ambient.d.ts': `type AmbientSize = 'sm' | 'lg'\n`,
      'src/Component.vue': usesAmbientType,
    })
    expect(dts).toContain('AmbientSize')
  })

  it('uses the `noUncheckedSideEffectImports` setting of the project', { timeout: 50_000 }, async () => {
    const files = (noUncheckedSideEffectImports: boolean) => ({
      'tsconfig.json': JSON.stringify({ compilerOptions: { noUncheckedSideEffectImports }, include: ['src'] }),
      'src/Component.vue': `<script setup lang="ts">import './styles.css'\ndefineProps<{ msg: string }>()</script><template><div /></template>`,
    })
    expect(await emitFixture('side-effect-imports-unchecked', files(false))).toContain('msg: string')
    await expect(emitFixture('side-effect-imports-checked', files(true))).rejects.toThrow('TS2882')
  })

  it('uses the strictness of the project', { timeout: 50_000 }, async () => {
    const dts = await emitFixture('not-strict', {
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: false }, include: ['src'] }),
      'src/Component.vue': [
        '<script setup lang="ts">',
        'const found = [1, 2].find(n => n > 1)',
        'const fixed = found.toFixed()',
        '</script>',
        '<template><div>{{ fixed }}</div></template>',
      ].join('\n'),
    })
    expect(dts).toContain('DefineComponent')
  })

  it('ignores errors in other files of the project', { timeout: 50_000 }, async () => {
    const dts = await emitFixture('unrelated-errors', {
      'tsconfig.json': JSON.stringify({ include: ['src', 'types'] }),
      'types/ambient.d.ts': `type AmbientSize = 'sm' | 'lg'\n`,
      'src/server.ts': `export const port: number = 'invalid'\n`,
      'src/Component.vue': usesAmbientType,
    })
    expect(dts).toContain('AmbientSize')
  })

  it('emits declarations whatever the project emit settings', { timeout: 50_000 }, async () => {
    const dts = await emitFixture('emit-settings', {
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          noEmit: true,
          noEmitOnError: true,
          declaration: false,
          declarationMap: true,
          composite: true,
          outDir: './dist',
          declarationDir: './dist/types',
          rootDir: './server',
        },
        include: ['src', 'types'],
      }),
      'types/ambient.d.ts': `type AmbientSize = 'sm' | 'lg'\n`,
      'src/server.ts': `export const port: number = 'invalid'\n`,
      'src/Component.vue': usesAmbientType,
    })
    expect(dts).toContain('AmbientSize')
    expect(dts).not.toContain('sourceMappingURL')
  })

  it('still fails on errors in the emitted SFCs', { timeout: 50_000 }, async () => {
    await expect(emitFixture('sfc-errors', {
      'tsconfig.json': JSON.stringify({ include: ['src'] }),
      'src/Component.vue': '<script setup lang="ts">const n: number = \'one\'</script><template><div>{{ n }}</div></template>',
    })).rejects.toThrow(/Component\.vue.*TS2322/)
  })

  it('merges `paths` over the tsconfig paths', { timeout: 50_000 }, async () => {
    const dts = await emitFixture('merged-paths', {
      'tsconfig.json': JSON.stringify({
        compilerOptions: { paths: { '#kept': ['./src/kept.ts'], '#replaced': ['./src/wrong.ts'] } },
        include: ['src'],
      }),
      'src/kept.ts': 'export interface Kept { label: string }\n',
      'src/wrong.ts': 'export interface Replaced { size: number }\n',
      'src/right.ts': `export interface Replaced { size: 'sm' }\n`,
      'src/Component.vue': [
        '<script setup lang="ts">',
        `import type { Kept } from '#kept'`,
        `import type { Replaced } from '#replaced'`,
        `const size: Replaced['size'] = 'sm'`,
        'defineProps<Kept>()',
        '</script>',
        '<template><div>{{ size }}</div></template>',
      ].join('\n'),
    }, root => ({ '#replaced': [join(root, 'src/right.ts')] }))
    expect(dts).toContain('Kept')
  })

  it('resolves the projects referenced by a solution-style tsconfig', { timeout: 50_000 }, async () => {
    const dts = await emitFixture('solution', {
      'tsconfig.json': JSON.stringify({
        files: [],
        references: [{ path: './.nuxt/tsconfig.server.json' }, { path: './.nuxt/tsconfig.app.json' }],
      }),
      '.nuxt/tsconfig.server.json': JSON.stringify({ include: ['../server'] }),
      '.nuxt/tsconfig.app.json': JSON.stringify({ include: ['../src', './types'] }),
      '.nuxt/types/ambient.d.ts': `type AmbientSize = 'sm' | 'lg'\n`,
      'server/index.ts': 'export {}\n',
      'src/Component.vue': usesAmbientType,
    })
    expect(dts).toContain('AmbientSize')
  })

  it('emits SFCs from each referenced project with its own types', { timeout: 50_000 }, async () => {
    const root = join(dir, 'multiple-projects')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'tsconfig.json'), JSON.stringify({
      files: [],
      references: [{ path: './app' }, { path: './server' }],
    }))
    const files = []
    for (const name of ['app', 'server']) {
      await mkdir(join(root, name), { recursive: true })
      await writeFile(join(root, name, 'tsconfig.json'), JSON.stringify({ include: ['.'] }))
      await writeFile(join(root, name, 'ambient.d.ts'), `type ProjectKind = '${name}'\n`)
      const id = join(root, name, 'Component.vue')
      const source = `<script setup lang="ts">const kind: ProjectKind = '${name}'\ndefineProps<{ kind: ProjectKind }>()</script><template><div>{{ kind }}</div></template>`
      await writeFile(id, source)
      files.push({ id, source })
    }

    const result = await emitVueDeclarations(files, { rootDir: root, tsconfig: join(root, 'tsconfig.json'), cache: false })
    for (const { id } of files) {
      expect(result.get(id)).toContain('ProjectKind')
    }
  })
})
