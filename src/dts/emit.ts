import type { DtsCache } from './cache'

import * as volarTs from '@volar/typescript'
import * as vueLanguageCore from '@vue/language-core'
import { join, normalize } from 'pathe'
import ts from 'typescript'

import { createFileSystemDtsCache, hashSfc } from './cache'
import { readTsconfigJson } from './tsconfig'
import { getAutoCacheVersion } from './version'

export type VueTscRunner = (
  files: Array<{ id: string, source: string }>,
  options: { rootDir: string, tsconfig?: string },
) => Map<string, string> | Promise<Map<string, string>>

export interface EmitVueDeclarationsOptions {
  rootDir: string
  tsconfig?: string
  // Content-hash cache. Defaults to a disk cache under
  // `<rootDir>/node_modules/.cache/vue-sfc-dts/`; pass a custom `DtsCache`
  // for in-memory / Redis / etc., or `false` to disable caching entirely.
  cache?: DtsCache | false
  // Optional extra string mixed into the cache key, on top of an auto-derived
  // version that already covers this package, `@vue/language-core`,
  // `@volar/typescript`, `typescript`, and the resolved `vueCompilerOptions`.
  // Use this only when you want an additional invalidation namespace under
  // your own control (e.g. "bump when this codegen helper changes").
  cacheVersion?: string
  // Override the TS+Volar runner. Tests use this; production callers don't.
  runner?: VueTscRunner
}

const runVueTsc: VueTscRunner = (files, options) => {
  const vfs = new Map<string, string>()
  for (const file of files) {
    vfs.set(normalize(file.id), file.source)
  }

  const parsed = vueLanguageCore.createParsedCommandLineByJson(
    ts,
    ts.sys,
    options.rootDir,
    readTsconfigJson(options.tsconfig),
    options.tsconfig,
  )

  // Mix the user's path-resolution options (`baseUrl`, `paths`,
  // `pathsBasePath`) into our hardcoded compiler options so imports like
  // `import type { Foo } from '#alias'` resolve when emitting declarations.
  const compilerOptions: ts.CompilerOptions = {
    allowJs: true,
    allowImportingTsExtensions: true,
    allowNonTsExtensions: true,
    declaration: true,
    emitDeclarationOnly: true,
    noEmit: false,
    skipLibCheck: true,
    strictNullChecks: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    ...(parsed.options.baseUrl !== undefined && { baseUrl: parsed.options.baseUrl }),
    ...(parsed.options.paths !== undefined && { paths: parsed.options.paths }),
    ...(parsed.options.pathsBasePath !== undefined && { pathsBasePath: parsed.options.pathsBasePath }),
  }

  const tsHost = ts.createCompilerHost(compilerOptions)
  tsHost.writeFile = (filename, content) => {
    vfs.set(normalize(filename), content)
  }
  const originalReadFile = tsHost.readFile.bind(tsHost)
  tsHost.readFile = (filename) => {
    const normalised = normalize(filename)
    if (vfs.has(normalised)) {
      return vfs.get(normalised)
    }
    return originalReadFile(filename)
  }
  const originalFileExists = tsHost.fileExists.bind(tsHost)
  tsHost.fileExists = filename => vfs.has(normalize(filename)) || originalFileExists(filename)

  const rootNames = files.map(f => normalize(f.id))
  const createProgram = volarTs.proxyCreateProgram(
    ts,
    ts.createProgram,
    (tsRef, programOptions) => {
      const vueLanguagePlugin = vueLanguageCore.createVueLanguagePlugin(
        tsRef,
        programOptions.options,
        parsed.vueOptions,
        (id: string) => id,
      )
      return [vueLanguagePlugin]
    },
  )

  const program = createProgram({ rootNames, options: compilerOptions, host: tsHost })
  program.emit()

  const out = new Map<string, string>()
  for (const file of files) {
    // vue-tsc writes `<path>.vue.d.ts` for SFC inputs
    const dtsPath = normalize(`${file.id}.d.ts`)
    const contents = vfs.get(dtsPath)
    if (contents !== undefined) {
      out.set(file.id, contents)
    }
  }
  return out
}

export async function emitVueDeclarations(
  files: Array<{ id: string, source: string }>,
  options: EmitVueDeclarationsOptions,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (files.length === 0) {
    return out
  }

  const cache = resolveCache(options)
  const version = cache
    ? [
        getAutoCacheVersion({ rootDir: options.rootDir, tsconfig: options.tsconfig }),
        options.cacheVersion,
      ].filter(Boolean).join('|')
    : ''

  const misses: typeof files = []
  const keys = new Map<string, string>()
  if (cache) {
    await Promise.all(files.map(async (file) => {
      const key = hashSfc(file.id, file.source, version)
      keys.set(file.id, key)
      const hit = await cache.getItem(key)
      // Both `null` (unstorage convention) and `undefined` count as misses.
      if (hit != null) {
        out.set(file.id, hit)
      }
      else {
        misses.push(file)
      }
    }))
  }
  else {
    misses.push(...files)
  }

  if (misses.length === 0) {
    return out
  }

  const fresh = await (options.runner ?? runVueTsc)(misses, options)
  for (const [id, dts] of fresh) {
    out.set(id, dts)
  }

  if (cache) {
    await Promise.all(misses.map(async (file) => {
      const dts = fresh.get(file.id)
      if (dts === undefined) {
        return
      }
      const key = keys.get(file.id)
      if (key === undefined) {
        return
      }
      await cache.setItem(key, dts)
    }))
  }

  return out
}

function resolveCache(options: EmitVueDeclarationsOptions): DtsCache | undefined {
  if (options.cache === false) {
    return undefined
  }
  if (options.cache) {
    return options.cache
  }
  return createFileSystemDtsCache({ dir: join(options.rootDir, 'node_modules/.cache/vue-sfc-dts') })
}
