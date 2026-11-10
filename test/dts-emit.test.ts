import type { DtsCache } from '../src/dts/cache'
import type { DeclarationDiagnostic } from '../src/dts/diagnostics'
import type { EmitVueDeclarationsOptions, EmitVueDeclarationsResult, VueDeclarationSource, VueTscRunner } from '../src/dts/emit'

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createFileSystemDtsCache, emitVueDeclarations, isDeclarationEmitDiagnostic } from '../src/core'
import { emitDeclarations } from '../src/dts/emit'

function dtsOf(result: EmitVueDeclarationsResult, id: string): string | undefined {
  return result.files.get(id.replace(/\.vue$/, '.d.vue.ts'))
}

describe('emitVueDeclarations (caching)', () => {
  const dir = fileURLToPath(new URL('../node_modules/.tmp/dts-emit', import.meta.url))

  beforeAll(async () => {
    await rm(dir, { force: true, recursive: true })
    await mkdir(dir, { recursive: true })
  })
  afterAll(async () => {
    await rm(dir, { force: true, recursive: true })
  })

  function fakeRunner(map: Record<string, string> = {}, diagnostics: DeclarationDiagnostic[] = []): VueTscRunner {
    return (files) => {
      const declarations = new Map<string, string>()
      for (const f of files) {
        declarations.set(f.id, map[f.id] ?? `declare const _${f.id.length}: ${JSON.stringify(f.source)}\n`)
      }
      return { declarations, diagnostics }
    }
  }

  function emitWith(files: VueDeclarationSource[], { runner, ...options }: EmitVueDeclarationsOptions & { runner: VueTscRunner }): Promise<EmitVueDeclarationsResult> {
    return emitDeclarations(files, options, runner)
  }

  it('returns empty for empty input', async () => {
    const result = await emitVueDeclarations([], { cwd: dir })
    expect(result.files.size).toBe(0)
    expect(result.diagnostics).toEqual([])
  })

  it('caches without a user-supplied `cacheVersion` (auto-derived) when a `cache` is explicitly provided', async () => {
    const cacheDir = join(dir, 'auto-version')
    const cache = createFileSystemDtsCache({ dir: cacheDir })
    const runner = vi.fn(fakeRunner({ '/auto.vue': 'declare const A: 1\n' }))
    const files = [{ id: '/auto.vue', source: 'auto' }]

    const first = await emitWith(files, { cwd: dir, cache, runner })
    expect(runner).toHaveBeenCalledTimes(1)
    expect(dtsOf(first, '/auto.vue')).toBe('declare const A: 1\n')

    const second = await emitWith(files, { cwd: dir, cache, runner })
    expect(runner).toHaveBeenCalledTimes(1)
    expect(dtsOf(second, '/auto.vue')).toBe('declare const A: 1\n')
  })

  it('skips caching entirely when `cache: false`', async () => {
    const runner = vi.fn(fakeRunner({ '/a.vue': 'declare const A: 1\n' }))
    const result = await emitWith(
      [{ id: '/a.vue', source: '<template/>' }],
      { cwd: dir, cache: false, runner },
    )
    expect(runner).toHaveBeenCalledTimes(1)
    expect(dtsOf(result, '/a.vue')).toBe('declare const A: 1\n')

    const second = await emitWith(
      [{ id: '/a.vue', source: '<template/>' }],
      { cwd: dir, cache: false, runner },
    )
    expect(runner).toHaveBeenCalledTimes(2)
    expect(dtsOf(second, '/a.vue')).toBe('declare const A: 1\n')
  })

  it('uses a default fs cache under `<cwd>/node_modules/.cache/vue-sfc-dts` when none is supplied', async () => {
    const cwd = join(dir, 'default-cache-root')
    await mkdir(cwd, { recursive: true })
    const runner = vi.fn(fakeRunner({ '/d.vue': 'declare const D: 1\n' }))
    const files = [{ id: '/d.vue', source: 'default-cache' }]

    const first = await emitWith(files, { cwd, runner })
    expect(runner).toHaveBeenCalledTimes(1)
    expect(dtsOf(first, '/d.vue')).toBe('declare const D: 1\n')

    const second = await emitWith(files, { cwd, runner })
    expect(runner).toHaveBeenCalledTimes(1)
    expect(dtsOf(second, '/d.vue')).toBe('declare const D: 1\n')
  })

  it('writes to the cache on a miss and reads on a subsequent hit', async () => {
    const cacheDir = join(dir, 'miss-then-hit')
    const cache: DtsCache = createFileSystemDtsCache({ dir: cacheDir })
    const runner = vi.fn(fakeRunner({ '/m.vue': 'declare const M: 1\n' }))
    const files = [{ id: '/m.vue', source: '<template>m</template>' }]
    const opts = { cwd: dir, cache, cacheVersion: 'v1', runner }

    const first = await emitWith(files, opts)
    expect(runner).toHaveBeenCalledTimes(1)
    expect(dtsOf(first, '/m.vue')).toBe('declare const M: 1\n')

    const second = await emitWith(files, opts)
    expect(runner).toHaveBeenCalledTimes(1)
    expect(dtsOf(second, '/m.vue')).toBe('declare const M: 1\n')
  })

  it('bypasses the cache when cacheVersion changes', async () => {
    const cacheDir = join(dir, 'version-bump')
    const cache = createFileSystemDtsCache({ dir: cacheDir })
    const runner = vi.fn(fakeRunner({ '/v.vue': 'declare const V: 1\n' }))
    const files = [{ id: '/v.vue', source: '<template>v</template>' }]

    await emitWith(files, { cwd: dir, cache, cacheVersion: 'v1', runner })
    expect(runner).toHaveBeenCalledTimes(1)

    await emitWith(files, { cwd: dir, cache, cacheVersion: 'v2', runner })
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('only re-runs the runner for cache misses on partial hits', async () => {
    const cacheDir = join(dir, 'partial')
    const cache = createFileSystemDtsCache({ dir: cacheDir })
    const runner = vi.fn(fakeRunner())
    const a = { id: '/a.vue', source: 'A' }
    const b = { id: '/b.vue', source: 'B' }

    await emitWith([a], { cwd: dir, cache, cacheVersion: 'v1', runner })
    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner.mock.calls[0]?.[0]).toEqual([a])

    runner.mockClear()
    const both = await emitWith([a, b], { cwd: dir, cache, cacheVersion: 'v1', runner })
    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner.mock.calls[0]?.[0]).toEqual([b])
    expect(both.files.size).toBe(2)
  })

  it('does not cache declarations from a run with errors', async () => {
    const cache = createFileSystemDtsCache({ dir: join(dir, 'errors') })
    const diagnostic: DeclarationDiagnostic = { code: 2322, category: 'error', kind: 'semantic', file: '/broken.vue', line: 1, column: 1, message: 'broken' }
    const runner = vi.fn(fakeRunner({}, [diagnostic]))
    const files = [{ id: '/broken.vue', source: 'broken' }, { id: '/clean.vue', source: 'clean' }]

    const first = await emitWith(files, { cwd: dir, cache, runner })
    expect(first.diagnostics).toEqual([diagnostic])
    expect(first.files.size).toBe(2)

    runner.mockClear()
    const second = await emitWith(files, { cwd: dir, cache, runner })
    expect(runner.mock.calls[0]?.[0]).toEqual(files)
    expect(second.diagnostics).toEqual([diagnostic])
  })

  it('also returns `.vue.d.ts` declarations with `emitLegacyDeclarationAlias`', async () => {
    const runner = fakeRunner({ '/src/Foo.vue': 'declare const F: 1\n' })
    const files = [{ id: '/src/Foo.vue', source: 'foo' }]

    const result = await emitWith(files, { cwd: dir, cache: false, runner, emitLegacyDeclarationAlias: true })
    expect([...result.files]).toEqual([
      ['/src/Foo.d.vue.ts', 'declare const F: 1\n'],
      ['/src/Foo.vue.d.ts', 'declare const F: 1\n'],
    ])
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

    const first = await emitWith(files, { cwd: dir, cache, runner })
    expect(runner).toHaveBeenCalledTimes(1)
    expect(dtsOf(first, '/u.vue')).toBe('declare const U: 1\n')
    expect(store.size).toBe(1)

    const second = await emitWith(files, { cwd: dir, cache, runner })
    expect(runner).toHaveBeenCalledTimes(1)
    expect(dtsOf(second, '/u.vue')).toBe('declare const U: 1\n')
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
    const source = `<script setup lang="ts">defineProps<{ msg: string }>()\n</script><template><div>{{ msg }}</div></template>`
    await writeFile(id, source)
    const result = await emitVueDeclarations([{ id, source }], { cwd: dir, cache: false })
    expect(result.diagnostics).toEqual([])
    expect([...result.files.keys()]).toEqual([join(dir, 'Hello.d.vue.ts')])
    const dts = dtsOf(result, id)
    expect(dts).toContain('msg')
    expect(dts).toContain('DefineComponent')
  })

  it('emits a declaration for an SFC with a side-effect stylesheet import', { timeout: 50_000 }, async () => {
    const id = join(dir, 'Styled.vue')
    const source = `<script setup lang="ts">import './styled.css'\ndefineProps<{ msg: string }>()\n</script><template><div>{{ msg }}</div></template>`
    await writeFile(id, source)
    const result = await emitVueDeclarations([{ id, source }], { cwd: dir, cache: false })
    expect(dtsOf(result, id)).toContain('msg')
  })

  it('resolves path aliases from tsconfig.compilerOptions.paths in emitted declarations', { timeout: 50_000 }, async () => {
    const root = join(dir, 'paths-test')
    await mkdir(root, { recursive: true })

    await writeFile(join(root, 'button-types.ts'), `export interface ButtonProps { label: string }\n`)

    await writeFile(join(root, 'tsconfig.json'), JSON.stringify({
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
      cwd: root,
      tsconfig: 'tsconfig.json',
      cache: false,
    })

    expect(result.diagnostics).toEqual([])
    expect(dtsOf(result, id)).toContain('ButtonProps')
  })

  it('resolves imports of cached SFCs from their supplied source', { timeout: 50_000 }, async () => {
    const root = join(dir, 'cached-import')
    await mkdir(root, { recursive: true })
    const store = new Map<string, string>()
    const cache: DtsCache = {
      getItem: async key => store.get(key),
      setItem: async (key, value) => void store.set(key, value),
    }
    const child = { id: join(root, 'Child.vue'), source: `<script lang="ts">\nexport interface ChildProps { label: string }\n</script>\n<template><div /></template>\n` }
    const parent = (prop: string) => ({
      id: join(root, 'Parent.vue'),
      source: `<script setup lang="ts">\nimport type { ChildProps } from './Child.vue'\ndefineProps<{ ${prop}: ChildProps }>()\n</script>\n<template><div /></template>\n`,
    })

    const first = await emitVueDeclarations([child, parent('first')], { cwd: root, cache })
    expect(first.diagnostics).toEqual([])
    const second = await emitVueDeclarations([child, parent('second')], { cwd: root, cache })
    expect(second.diagnostics).toEqual([])
    expect(dtsOf(second, parent('second').id)).toContain('second: ChildProps')
  })

  it('ignores errors in files other than the emitted SFCs', { timeout: 50_000 }, async () => {
    const root = join(dir, 'unrelated-errors')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'types.ts'), [
      'export interface Props { msg: string }',
      'export const broken: number = \'not a number\'',
    ].join('\n'))

    const id = join(root, 'Hello.vue')
    const source = `<script setup lang="ts">import type { Props } from './types'\ndefineProps<Props>()\n</script><template><div>{{ msg }}</div></template>`
    await writeFile(id, source)

    const result = await emitVueDeclarations([{ id, source }], { cwd: root, cache: false })
    expect(result.diagnostics).toEqual([])
    expect(dtsOf(result, id)).toContain('Props')
  })

  it('returns semantic errors with their location in the SFC', { timeout: 50_000 }, async () => {
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

    const result = await emitVueDeclarations([{ id, source }], { cwd: root, cache: false })
    expect(result.diagnostics).toEqual([{
      code: 2307,
      category: 'error',
      kind: 'semantic',
      file: id,
      line: 2,
      column: 35,
      message: `Cannot find module '#missing' or its corresponding type declarations.`,
    }])
    expect(isDeclarationEmitDiagnostic(result.diagnostics[0]!)).toBe(false)
    expect(dtsOf(result, id)).toContain('DefineComponent')
  })

  it('returns syntax errors as emit-affecting', { timeout: 50_000 }, async () => {
    const root = join(dir, 'syntax-error')
    await mkdir(root, { recursive: true })

    const id = join(root, 'Syntax.vue')
    const source = `<script setup lang="ts">\nconst n = (1\n</script>\n<template><div /></template>\n`
    await writeFile(id, source)

    const result = await emitVueDeclarations([{ id, source }], { cwd: root, cache: false })
    const [diagnostic] = result.diagnostics
    expect(diagnostic).toMatchObject({ code: 1005, kind: 'syntactic', file: id })
    expect(isDeclarationEmitDiagnostic(diagnostic!)).toBe(true)
  })

  it('returns non-portable inferred types as emit-affecting and skips their emit', { timeout: 50_000 }, async () => {
    const root = join(dir, 'portability')
    const fixture: Record<string, string> = {
      'node_modules/dep/package.json': JSON.stringify({ name: 'dep', types: 'index.d.ts' }),
      'node_modules/dep/index.d.ts': `import type { Inner } from 'inner'\nexport declare function make(): Inner\n`,
      'node_modules/dep/node_modules/inner/package.json': JSON.stringify({ name: 'inner', types: 'index.d.ts' }),
      'node_modules/dep/node_modules/inner/index.d.ts': 'export interface Inner { value: string }\n',
    }
    for (const [path, contents] of Object.entries(fixture)) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), contents)
    }
    const id = join(root, 'Exposed.vue')
    const source = `<script setup lang="ts">\nimport { make } from 'dep'\ndefineExpose({ inner: make() })\n</script>\n<template><div /></template>\n`
    await writeFile(id, source)

    const result = await emitVueDeclarations([{ id, source }], { cwd: root, cache: false })
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 2883, category: 'error', kind: 'declaration', file: id })])
    expect(isDeclarationEmitDiagnostic(result.diagnostics[0]!)).toBe(true)
    expect(result.files.size).toBe(0)
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

  async function emitFixture(name: string, files: Record<string, string>, paths?: Record<string, string[]>): Promise<EmitVueDeclarationsResult & { dts?: string }> {
    const root = join(dir, name)
    for (const [path, contents] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), contents)
    }
    const id = join(root, 'src/Component.vue')
    const result = await emitVueDeclarations([{ id, source: files['src/Component.vue']! }], {
      cwd: root,
      tsconfig: 'tsconfig.json',
      paths,
      cache: false,
    })
    return { ...result, dts: dtsOf(result, id) }
  }

  const usesAmbientType = [
    '<script setup lang="ts">',
    'defineProps<{ size: AmbientSize }>()',
    '</script>',
    '<template><div /></template>',
  ].join('\n')

  it('includes ambient declarations from the tsconfig `include`', { timeout: 50_000 }, async () => {
    const { dts, diagnostics } = await emitFixture('ambient', {
      'tsconfig.json': JSON.stringify({ include: ['src', 'types'] }),
      'types/ambient.d.ts': `type AmbientSize = 'sm' | 'lg'\n`,
      'src/Component.vue': usesAmbientType,
    })
    expect(diagnostics).toEqual([])
    expect(dts).toContain('AmbientSize')
  })

  it('uses the `noUncheckedSideEffectImports` setting of the project', { timeout: 50_000 }, async () => {
    const files = (noUncheckedSideEffectImports: boolean) => ({
      'tsconfig.json': JSON.stringify({ compilerOptions: { noUncheckedSideEffectImports }, include: ['src'] }),
      'src/Component.vue': `<script setup lang="ts">import './styles.css'\ndefineProps<{ msg: string }>()\n</script><template><div /></template>`,
    })
    const unchecked = await emitFixture('side-effect-imports-unchecked', files(false))
    expect(unchecked.diagnostics).toEqual([])
    expect(unchecked.dts).toContain('msg: string')
    const checked = await emitFixture('side-effect-imports-checked', files(true))
    expect(checked.diagnostics.map(diagnostic => diagnostic.code)).toEqual([2882])
  })

  it('uses the strictness of the project', { timeout: 50_000 }, async () => {
    const { dts, diagnostics } = await emitFixture('not-strict', {
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: false }, include: ['src'] }),
      'src/Component.vue': [
        '<script setup lang="ts">',
        'const found = [1, 2].find(n => n > 1)',
        'const fixed = found.toFixed()',
        '</script>',
        '<template><div>{{ fixed }}</div></template>',
      ].join('\n'),
    })
    expect(diagnostics).toEqual([])
    expect(dts).toContain('DefineComponent')
  })

  it('ignores errors in other files of the project', { timeout: 50_000 }, async () => {
    const { dts, diagnostics } = await emitFixture('unrelated-errors', {
      'tsconfig.json': JSON.stringify({ include: ['src', 'types'] }),
      'types/ambient.d.ts': `type AmbientSize = 'sm' | 'lg'\n`,
      'src/server.ts': `export const port: number = 'invalid'\n`,
      'src/Component.vue': usesAmbientType,
    })
    expect(diagnostics).toEqual([])
    expect(dts).toContain('AmbientSize')
  })

  it('emits declarations whatever the project emit settings', { timeout: 50_000 }, async () => {
    const { dts, diagnostics } = await emitFixture('emit-settings', {
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
    expect(diagnostics).toEqual([])
    expect(dts).toContain('AmbientSize')
    expect(dts).not.toContain('sourceMappingURL')
  })

  it('returns errors in the emitted SFCs', { timeout: 50_000 }, async () => {
    const { dts, diagnostics } = await emitFixture('sfc-errors', {
      'tsconfig.json': JSON.stringify({ include: ['src'] }),
      'src/Component.vue': '<script setup lang="ts">const n: number = \'one\'</script><template><div>{{ n }}</div></template>',
    })
    expect(diagnostics).toEqual([expect.objectContaining({
      code: 2322,
      category: 'error',
      kind: 'semantic',
      file: join(dir, 'sfc-errors/src/Component.vue'),
      line: 1,
      column: 31,
    })])
    expect(dts).toContain('DefineComponent')
  })

  it('merges `paths` over the tsconfig paths', { timeout: 50_000 }, async () => {
    const { dts, diagnostics } = await emitFixture('merged-paths', {
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
    }, { '#replaced': ['./src/right.ts'] })
    expect(diagnostics).toEqual([])
    expect(dts).toContain('Kept')
  })

  it('resolves the projects referenced by a solution-style tsconfig', { timeout: 50_000 }, async () => {
    const { dts, diagnostics } = await emitFixture('solution', {
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
    expect(diagnostics).toEqual([])
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
      const source = `<script setup lang="ts">const kind: ProjectKind = '${name}'\ndefineProps<{ kind: ProjectKind }>()\n</script><template><div>{{ kind }}</div></template>`
      await writeFile(id, source)
      files.push({ id, source })
    }

    const result = await emitVueDeclarations(files, { cwd: root, tsconfig: join(root, 'tsconfig.json'), cache: false })
    expect(result.diagnostics).toEqual([])
    for (const { id } of files) {
      expect(dtsOf(result, id)).toContain('ProjectKind')
    }
  })
})
