import type { DtsCache } from './cache'
import type { DeclarationProject } from './project'

import * as volarTs from '@volar/typescript'
import * as vueLanguageCore from '@vue/language-core'
import ts from 'typescript'

import { join, normalize } from '../utils/path'
import { createFileSystemDtsCache, hashSfc } from './cache'
import { resolveDeclarationProjects } from './project'
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
  // `@volar/typescript`, `typescript`, and the resolved compiler options and
  // `vueCompilerOptions`.
  // Use this only when you want an additional invalidation namespace under
  // your own control (e.g. "bump when this codegen helper changes").
  cacheVersion?: string
  // Override the TS+Volar runner. Tests use this; production callers don't.
  runner?: VueTscRunner
}

// Declarations are read back from next to each source file, and errors in
// other files of the project must not suppress their emit.
const DECLARATION_EMIT_OPTIONS: ts.CompilerOptions = {
  allowNonTsExtensions: true,
  composite: false,
  declaration: true,
  declarationDir: undefined,
  declarationMap: false,
  emitDeclarationOnly: true,
  incremental: false,
  noEmit: false,
  noEmitOnError: false,
  outDir: undefined,
  outFile: undefined,
  rootDir: undefined,
  tsBuildInfoFile: undefined,
}

const runVueTsc: VueTscRunner = (files, options) => {
  const projects = resolveDeclarationProjects(options.rootDir, options.tsconfig)
  const projectFileNames = projects.map(project => new Set(project.fileNames))
  const groups = new Map<DeclarationProject, typeof files>()
  for (const file of files) {
    const id = normalize(file.id)
    const project = projects[projectFileNames.findIndex(fileNames => fileNames.has(id))] ?? projects[0]!
    groups.set(project, [...groups.get(project) ?? [], file])
  }

  const out = new Map<string, string>()
  for (const [project, group] of groups) {
    for (const [id, dts] of emitProjectDeclarations(project, group, options.rootDir)) {
      out.set(id, dts)
    }
  }
  return out
}

function emitProjectDeclarations(
  project: DeclarationProject,
  files: Array<{ id: string, source: string }>,
  rootDir: string,
): Map<string, string> {
  const vfs = new Map<string, string>()
  for (const file of files) {
    vfs.set(normalize(file.id), file.source)
  }

  const compilerOptions: ts.CompilerOptions = {
    ...project.options,
    jsx: project.options.jsx ?? ts.JsxEmit.Preserve,
    jsxImportSource: project.options.jsxImportSource ?? 'vue',
    ...DECLARATION_EMIT_OPTIONS,
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

  const rootNames = [...new Set([...project.fileNames, ...files.map(f => normalize(f.id)).sort()])]
  const createProgram = volarTs.proxyCreateProgram(
    ts,
    ts.createProgram,
    (tsRef, programOptions) => {
      const vueLanguagePlugin = vueLanguageCore.createVueLanguagePlugin(
        tsRef,
        programOptions.options,
        project.vueOptions,
        (id: string) => id,
      )
      return [vueLanguagePlugin]
    },
  )

  const program = createProgram({ rootNames, options: compilerOptions, host: tsHost })
  const diagnostics: ts.Diagnostic[] = []
  let emitSkipped = false
  const emitted = new Set(files.map(file => normalize(file.id)))
  for (const sourceFile of program.getSourceFiles()) {
    if (!emitted.has(normalize(sourceFile.fileName))) {
      continue
    }
    diagnostics.push(...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile))
    const emitResult = program.emit(sourceFile)
    emitSkipped ||= emitResult.emitSkipped
    diagnostics.push(...emitResult.diagnostics)
  }
  const errorDiagnostics = diagnostics.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
  if (emitSkipped && !errorDiagnostics.length) {
    errorDiagnostics.push(...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics())
  }
  if (emitSkipped || errorDiagnostics.length) {
    throw new Error(`[vue-sfc-transformer] failed to emit Vue declarations:\n${
      formatDiagnostics(errorDiagnostics, rootDir)}`)
  }

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

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[], rootDir: string): string {
  return ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: fileName => fileName,
    getCurrentDirectory: () => rootDir,
    getNewLine: () => ts.sys.newLine,
  }).trim()
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
