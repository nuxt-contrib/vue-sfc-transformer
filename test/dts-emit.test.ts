import type { DtsCache } from '../src/dts/cache'
import type { EmitVueDeclarationsOptions, VueTscRunner } from '../src/dts/emit'

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'pathe'
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
})
