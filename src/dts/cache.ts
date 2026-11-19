import type { DeclarationDiagnostic } from './diagnostics'

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

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

export interface DtsCacheEntry {
  dts: string
  diagnostics: DeclarationDiagnostic[]
  /**
   * The files the declaration and diagnostics depend on, by path, with the
   * hash of their declaration when emitted in the same program and of their
   * text otherwise.
   */
  dependencies: Record<string, string>
}

/** What the program of a project read, to reuse its entries without one. */
export interface DtsCacheProgramInputs {
  /** Ids of the sources the program emitted. */
  ids: string[]
  /** Hash of the text of each file the program read that can change, by path. */
  files: Record<string, string>
  /** Paths where a new file would change a module resolution. */
  absent: string[]
}

/** What the last call with the same sources read. */
export interface DtsCacheManifest {
  /** Hash of the entry of each source, by id. */
  entries: Record<string, string>
  programs: DtsCacheProgramInputs[]
}

// Bumped when the shape of cached values changes, so entries written in
// another shape are never read.
export const CACHE_ENTRY_FORMAT = '2'

export function hashText(text: string | undefined): string {
  return text === undefined ? '' : createHash('sha256').update(text).digest('hex')
}

export function parseCacheEntry(value: string): DtsCacheEntry | undefined {
  const entry = parseJson(value) as Partial<DtsCacheEntry> | undefined
  if (typeof entry?.dts === 'string' && Array.isArray(entry.diagnostics) && isRecord(entry.dependencies)) {
    return { dts: entry.dts, diagnostics: entry.diagnostics, dependencies: entry.dependencies }
  }
  return undefined
}

export function parseCacheManifest(value: string): DtsCacheManifest | undefined {
  const manifest = parseJson(value) as Partial<DtsCacheManifest> | undefined
  const programs = manifest?.programs
  if (isRecord(manifest?.entries) && Array.isArray(programs) && programs.every(program =>
    Array.isArray(program?.ids) && isRecord(program.files) && Array.isArray(program.absent))) {
    return { entries: manifest.entries, programs }
  }
  return undefined
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  }
  catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && Object.values(value).every(item => typeof item === 'string')
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
      const tmp = `${target}.${randomUUID()}.tmp`
      await writeFile(tmp, value)
      await rename(tmp, target)
    },
  }
}
