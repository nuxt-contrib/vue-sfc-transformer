import { access, mkdir, readdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'pathe'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createFileSystemDtsCache, hashSfc } from '../src/dts/cache'

describe('hashSfc', () => {
  it('is deterministic', () => {
    expect(hashSfc('/a.vue', 'x', 'v1')).toBe(hashSfc('/a.vue', 'x', 'v1'))
  })

  it('changes when the version changes', () => {
    expect(hashSfc('/a.vue', 'x', 'v1')).not.toBe(hashSfc('/a.vue', 'x', 'v2'))
  })

  it('changes when the id changes', () => {
    expect(hashSfc('/a.vue', 'x', 'v1')).not.toBe(hashSfc('/b.vue', 'x', 'v1'))
  })

  it('changes when the source changes', () => {
    expect(hashSfc('/a.vue', 'x', 'v1')).not.toBe(hashSfc('/a.vue', 'y', 'v1'))
  })

  // Without delimiters, hash('a', 'b') would equal hash('ab', '') and trivial
  // collisions would slip through.
  it('separates fields so concatenation collisions are impossible', () => {
    expect(hashSfc('a', 'bc', 'v')).not.toBe(hashSfc('ab', 'c', 'v'))
    expect(hashSfc('a', 'b', 'vc')).not.toBe(hashSfc('a', 'bc', 'v'))
  })
})

describe('createFileSystemDtsCache', () => {
  const dir = fileURLToPath(new URL('../node_modules/.tmp/dts-cache', import.meta.url))

  beforeAll(async () => {
    await rm(dir, { force: true, recursive: true })
    await mkdir(dir, { recursive: true })
  })
  afterAll(async () => {
    await rm(dir, { force: true, recursive: true })
  })

  it('returns null for missing keys', async () => {
    const cache = createFileSystemDtsCache({ dir })
    expect(await cache.getItem('does-not-exist')).toBeNull()
  })

  it('round-trips setItem then getItem', async () => {
    const cache = createFileSystemDtsCache({ dir })
    await cache.setItem('hello', 'export const x = 1\n')
    expect(await cache.getItem('hello')).toBe('export const x = 1\n')
  })

  it('writes atomically (no tmp files left behind on success)', async () => {
    const cache = createFileSystemDtsCache({ dir })
    await cache.setItem('atomic', 'declare const _: 1\n')
    const files = await readdir(dir)
    expect(files).toContain('atomic.d.ts')
    expect(files.some(f => f.includes('.tmp'))).toBe(false)
  })

  it('overwrites an existing entry', async () => {
    const cache = createFileSystemDtsCache({ dir })
    await cache.setItem('overwrite', 'first')
    await cache.setItem('overwrite', 'second')
    expect(await cache.getItem('overwrite')).toBe('second')
  })

  it('persists across cache instances pointed at the same dir', async () => {
    const a = createFileSystemDtsCache({ dir })
    await a.setItem('shared', 'persisted')
    const b = createFileSystemDtsCache({ dir })
    expect(await b.getItem('shared')).toBe('persisted')
    // Sanity check the on-disk layout while we're here.
    await expect(access(join(dir, 'shared.d.ts'))).resolves.toBeUndefined()
  })
})
