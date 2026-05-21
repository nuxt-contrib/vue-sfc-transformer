import { mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { clearAutoCacheVersionMemo, getAutoCacheVersion } from '../src/dts/version'

const dir = fileURLToPath(new URL('../node_modules/.tmp/dts-version', import.meta.url))

describe('getAutoCacheVersion', () => {
  beforeAll(async () => {
    await rm(dir, { force: true, recursive: true })
    await mkdir(dir, { recursive: true })
  })
  beforeEach(() => {
    clearAutoCacheVersionMemo()
  })
  afterAll(async () => {
    await rm(dir, { force: true, recursive: true })
  })

  it('includes installed versions of the relevant packages', () => {
    const v = getAutoCacheVersion({ rootDir: dir })
    expect(v).toMatch(/vue-sfc-transformer=/)
    expect(v).toMatch(/@vue\/language-core=\d/)
    expect(v).toMatch(/@volar\/typescript=\d/)
    expect(v).toMatch(/typescript=\d/)
    expect(v).toMatch(/vueCompilerOptions=[a-f0-9]+/)
  })

  it('memoises across calls', () => {
    const a = getAutoCacheVersion({ rootDir: dir })
    const b = getAutoCacheVersion({ rootDir: dir })
    expect(a).toBe(b)
  })
})
