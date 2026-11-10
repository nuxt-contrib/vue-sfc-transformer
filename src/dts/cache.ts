import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'

// Structurally compatible with the `getItem` / `setItem` subset of
// unstorage's `Storage` interface, so any unstorage instance (or driver
// wrapped in `createStorage()`) can be passed directly as a cache.
export interface DtsCache {
  getItem: (key: string) => Promise<string | null | undefined>
  setItem: (key: string, value: string) => Promise<void>
}

// `version` is mixed in so a tooling upgrade invalidates the cache; `id`
// because identical source at different paths can emit different .d.ts
// (paths leak into emitted module specifiers).
export function hashSfc(id: string, source: string, version: string): string {
  return createHash('sha256')
    .update(version)
    .update('\0')
    .update(id)
    .update('\0')
    .update(source)
    .digest('hex')
}

// Declarations depend on the other sources they import, so every source is
// mixed into each key.
export function hashSources(sources: Array<{ id: string, source: string }>): string {
  const hash = createHash('sha256')
  for (const { id, source } of [...sources].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    hash.update(id).update('\0').update(source).update('\0')
  }
  return hash.digest('hex')
}

export function createFileSystemDtsCache(options: { dir: string }): DtsCache {
  const { dir } = options
  return {
    async getItem(key) {
      try {
        return await readFile(join(dir, `${key}.d.ts`), 'utf8')
      }
      catch {
        return null
      }
    },
    async setItem(key, value) {
      const target = join(dir, `${key}.d.ts`)
      await mkdir(dirname(target), { recursive: true })
      // tmp + rename so concurrent builds can't observe a partial write
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
      await writeFile(tmp, value)
      await rename(tmp, target)
    },
  }
}
