import type TypeScript from 'typescript'
import type { DtsCache } from './cache'
import type { DeclarationDiagnostic } from './diagnostics'
import type { DeclarationProject } from './project'
import type { SourceFileReuse, VueDeclarationSession } from './session'
import type { Toolchain } from './toolchain'

import process from 'node:process'

import { join, normalize, resolve } from '../utils/path'
import { CACHE_ENTRY_FORMAT, createFileSystemDtsCache, hashSfc, hashSources, parseCacheEntry, serializeCacheEntry } from './cache'
import { isDeclarationEmitDiagnostic, toDeclarationDiagnostic } from './diagnostics'
import { resolveDeclarationProjects } from './project'
import { reuseSourceFiles } from './session'
import { canDisposeVirtualCode, loadToolchain } from './toolchain'
import { getAutoCacheVersion } from './version'

export interface VueDeclarationSource {
  /**
   * Absolute path of an SFC, a `.ts` / `.mts` / `.cts` / `.tsx` script, or a
   * declaration file. Declaration files are not emitted, only made part of
   * the program.
   */
  id: string
  /** Source, which takes precedence over the file on disk. */
  source: string
}

export interface EmitVueDeclarationsOptions {
  /**
   * Project root: relative `tsconfig` and `paths` targets resolve against it,
   * the project's `vue-tsc` is looked up from it, and the default cache lives
   * under it. Defaults to `process.cwd()`.
   */
  cwd?: string
  /**
   * Path to a tsconfig.json. Declarations are emitted from the project it
   * describes: its compiler options, `vueCompilerOptions` and files (including
   * any `extends` chain), or the projects it references when it has no files
   * of its own. Throws if the file is missing or unparseable.
   */
  tsconfig?: string
  /**
   * Extra `compilerOptions.paths`, with targets relative to `cwd`, taking
   * precedence over the tsconfig's.
   */
  paths?: Record<string, string[]>
  /**
   * Content-hash cache for emitted declarations. Defaults to a disk cache
   * under `<cwd>/node_modules/.cache/vue-sfc-dts/`; pass a custom `DtsCache`
   * for in-memory / Redis / etc., or `false` to disable caching entirely.
   * Keys cover every source passed in, so changing one re-emits them all.
   * Each declaration is cached with the diagnostics of its source, which are
   * returned again on a hit. Nothing is cached from a run with errors that
   * affect declarations or with program option errors, so they are reported
   * again on the next run.
   */
  cache?: DtsCache | false
  /**
   * Extra string mixed into the cache key. The cache already invalidates on
   * version changes to this package, `@vue/language-core`, `@volar/typescript`,
   * `typescript`, and the resolved compiler options and `vueCompilerOptions`.
   */
  cacheVersion?: string
  /**
   * Also return a `<name>.vue.d.ts` declaration alongside `<name>.d.vue.ts`
   * for each SFC.
   */
  emitLegacyDeclarationAlias?: boolean
  /**
   * A session from `createVueDeclarationSession()`, to reuse the sources
   * parsed by the previous call it was passed to.
   */
  session?: VueDeclarationSession
}

export interface EmitVueDeclarationsResult {
  /**
   * Declarations keyed by absolute path, next to each source: `Foo.d.vue.ts`
   * for `Foo.vue` (plus `Foo.vue.d.ts` with `emitLegacyDeclarationAlias`),
   * `foo.d.ts` for `foo.ts` or `foo.tsx`, `foo.d.mts` for `foo.mts` and
   * `foo.d.cts` for `foo.cts`. A source without an entry had its emit
   * skipped; `diagnostics` gives the reason.
   */
  files: Map<string, string>
  /**
   * Diagnostics of the emitted sources and, when emit was skipped for no
   * other reason, of the program options. Use `isDeclarationEmitDiagnostic` to tell
   * the errors that affect declarations from other type errors.
   */
  diagnostics: DeclarationDiagnostic[]
}

interface ResolvedEmitOptions {
  rootDir: string
  tsconfig?: string
  paths?: Record<string, string[]>
  session?: VueDeclarationSession
}

interface DeclarationRun {
  declarations: Map<string, string>
  /** Diagnostics reported while checking and emitting each file, keyed by its id. */
  diagnostics: Map<string, DeclarationDiagnostic[]>
  /** Program option and global diagnostics. */
  programDiagnostics: DeclarationDiagnostic[]
}

// `files` are emitted; `sources` also includes cache hits and declaration
// files, which emitted files may import.
export type VueTscRunner = (
  files: VueDeclarationSource[],
  options: ResolvedEmitOptions,
  sources: VueDeclarationSource[],
) => DeclarationRun | Promise<DeclarationRun>

// Declarations are read back from next to each source file, and errors in
// other files of the project must not suppress their emit.
const DECLARATION_EMIT_OPTIONS: TypeScript.CompilerOptions = {
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

const DECLARATION_FILE_RE = /\.d\.(?:[^./]+\.)?[cm]?ts$/
const SCRIPT_FILE_RE = /\.([cm]?)tsx?$/

function isDeclarationFile(id: string): boolean {
  return DECLARATION_FILE_RE.test(id)
}

function isScriptFile(id: string): boolean {
  return !isDeclarationFile(id) && SCRIPT_FILE_RE.test(id)
}

function declarationPath(id: string): string {
  return isScriptFile(id)
    ? id.replace(SCRIPT_FILE_RE, '.d.$1ts')
    : id.replace(/\.([^./]+)$/, '.d.$1.ts')
}

const runVueTsc: VueTscRunner = (files, options, sources) => {
  const toolchain = loadToolchain(options.rootDir)
  const projects = resolveDeclarationProjects(toolchain, options.rootDir, options.tsconfig, options.paths)
  const projectFileNames = projects.map(project => new Set(project.fileNames))
  const projectOf = (file: VueDeclarationSource): DeclarationProject => {
    const id = normalize(file.id)
    return projects[projectFileNames.findIndex(fileNames => fileNames.has(id))] ?? projects[0]!
  }
  const groups = new Map<DeclarationProject, typeof files>()
  for (const file of files) {
    const project = projectOf(file)
    groups.set(project, [...groups.get(project) ?? [], file])
  }

  const reuse = options.session && reuseSourceFiles(options.session, toolchain.ts)
  const result: DeclarationRun = { declarations: new Map(), diagnostics: new Map(), programDiagnostics: [] }
  for (const [project, group] of groups) {
    const roots = sources.filter(file => projectOf(file) === project)
    const run = emitProjectDeclarations(toolchain, project, group, sources, roots, reuse)
    for (const [id, dts] of run.declarations) {
      result.declarations.set(id, dts)
    }
    for (const [id, diagnostics] of run.diagnostics) {
      result.diagnostics.set(id, diagnostics)
    }
    result.programDiagnostics.push(...run.programDiagnostics)
  }
  reuse?.commit()
  return result
}

function emitProjectDeclarations(
  toolchain: Toolchain,
  project: DeclarationProject,
  files: VueDeclarationSource[],
  sources: VueDeclarationSource[],
  roots: VueDeclarationSource[],
  reuse: SourceFileReuse | undefined,
): DeclarationRun {
  const { ts, volarTs, vueLanguageCore } = toolchain
  const vfs = new Map<string, string>()
  for (const file of sources) {
    vfs.set(normalize(file.id), file.source)
  }

  const compilerOptions: TypeScript.CompilerOptions = {
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
  reuse?.wrap(tsHost, compilerOptions)

  const rootNames = [...new Set([...project.fileNames, ...roots.map(f => normalize(f.id)).sort()])]
  let scripts: { delete: (id: string) => void } | undefined
  const createProgram = volarTs.proxyCreateProgram(
    ts,
    ts.createProgram,
    (tsRef, programOptions) => ({
      languagePlugins: [
        vueLanguageCore.createVueLanguagePlugin(
          tsRef,
          programOptions.options,
          project.vueOptions,
          (id: string) => id,
        ),
      ],
      setup: (language) => {
        if (canDisposeVirtualCode(toolchain)) {
          scripts = language.scripts
        }
      },
    }),
  )

  const program = createProgram({ rootNames, options: compilerOptions, host: tsHost })
  try {
    return emitProgramDeclarations(ts, program, files, vfs)
  }
  finally {
    // The virtual code of each SFC retains the program that created it.
    // `@vue/language-core` registers it at module level, and
    // `@vue/compiler-core` keeps the options of its last template parse,
    // whose error callback references it.
    for (const sourceFile of program.getSourceFiles()) {
      scripts?.delete(sourceFile.fileName)
    }
    vueLanguageCore.parse('')
  }
}

function emitProgramDeclarations(
  ts: typeof TypeScript,
  program: TypeScript.Program,
  files: VueDeclarationSource[],
  vfs: Map<string, string>,
): DeclarationRun {
  const diagnostics = new Map<string, DeclarationDiagnostic[]>()
  const programDiagnostics: DeclarationDiagnostic[] = []
  let emitSkipped = false
  const emitted = new Map(files.map(file => [normalize(file.id), file.id]))
  for (const sourceFile of program.getSourceFiles()) {
    const id = emitted.get(normalize(sourceFile.fileName))
    if (id === undefined) {
      continue
    }
    const fileDiagnostics: DeclarationDiagnostic[] = []
    diagnostics.set(id, fileDiagnostics)
    for (const diagnostic of program.getSyntacticDiagnostics(sourceFile)) {
      fileDiagnostics.push(toDeclarationDiagnostic(ts, diagnostic, 'syntactic'))
    }
    for (const diagnostic of program.getSemanticDiagnostics(sourceFile)) {
      fileDiagnostics.push(toDeclarationDiagnostic(ts, diagnostic, 'semantic'))
    }
    const emitResult = program.emit(sourceFile)
    emitSkipped ||= emitResult.emitSkipped
    for (const diagnostic of emitResult.diagnostics) {
      fileDiagnostics.push(toDeclarationDiagnostic(ts, diagnostic, 'declaration'))
    }
  }
  if (emitSkipped && ![...diagnostics.values()].some(list => list.some(diagnostic => diagnostic.category === 'error' && isDeclarationEmitDiagnostic(diagnostic)))) {
    for (const diagnostic of [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()]) {
      programDiagnostics.push(toDeclarationDiagnostic(ts, diagnostic, 'options'))
    }
  }

  const declarations = new Map<string, string>()
  for (const file of files) {
    // vue-tsc writes `<path>.vue.d.ts` for SFC inputs
    const contents = vfs.get(normalize(isScriptFile(file.id) ? declarationPath(file.id) : `${file.id}.d.ts`))
    if (contents !== undefined) {
      declarations.set(file.id, contents)
    }
  }
  return { declarations, diagnostics, programDiagnostics }
}

/**
 * Emit declarations for Vue SFCs and TypeScript files with `vue-tsc`'s
 * language plugin, in one program from the project described by `tsconfig`
 * (or default options without one), so TypeScript files can import types from
 * SFCs. Errors in other files of the project are not reported.
 *
 * Uses the TypeScript, `@vue/language-core` and `@volar/typescript` of the
 * project's `vue-tsc` (v3 or later) when it has one, and this package's peer
 * dependencies otherwise.
 *
 * Diagnostics are returned rather than thrown.
 */
export function emitVueDeclarations(
  files: VueDeclarationSource[],
  options: EmitVueDeclarationsOptions = {},
): Promise<EmitVueDeclarationsResult> {
  return emitDeclarations(files, options, runVueTsc)
}

export async function emitDeclarations(
  files: VueDeclarationSource[],
  options: EmitVueDeclarationsOptions,
  runner: VueTscRunner,
): Promise<EmitVueDeclarationsResult> {
  const result: EmitVueDeclarationsResult = { files: new Map(), diagnostics: [] }
  const emitted = files.filter(file => !isDeclarationFile(file.id))
  if (emitted.length === 0) {
    return result
  }

  const rootDir = options.cwd ?? process.cwd()
  const resolved: ResolvedEmitOptions = {
    rootDir,
    tsconfig: options.tsconfig ? resolve(rootDir, options.tsconfig) : undefined,
    paths: options.paths
      ? Object.fromEntries(Object.entries(options.paths).map(([key, targets]) => [key, targets.map(target => resolve(rootDir, target))]))
      : undefined,
    session: options.session,
  }

  const entries = new Map<string, { dts?: string, diagnostics: DeclarationDiagnostic[] }>()
  const cache = options.cache === false
    ? undefined
    : options.cache || createFileSystemDtsCache({ dir: join(rootDir, 'node_modules/.cache/vue-sfc-dts') })
  const version = cache
    ? [getAutoCacheVersion(resolved), options.cacheVersion, `entry=${CACHE_ENTRY_FORMAT}`, `sources=${hashSources(files)}`].filter(Boolean).join('|')
    : ''

  const keys = new Map<string, string>()
  if (cache) {
    await Promise.all(emitted.map(async (file) => {
      const key = hashSfc(file.id, file.source, version)
      keys.set(file.id, key)
      const hit = await cache.getItem(key)
      // Both `null` (unstorage convention) and `undefined` count as misses.
      const entry = hit == null ? undefined : parseCacheEntry(hit)
      if (entry) {
        entries.set(file.id, entry)
      }
    }))
  }
  const misses = emitted.filter(file => !entries.has(file.id))

  let programDiagnostics: DeclarationDiagnostic[] = []
  if (misses.length) {
    const run = await runner(misses, resolved, files)
    programDiagnostics = run.programDiagnostics
    for (const file of misses) {
      entries.set(file.id, { dts: run.declarations.get(file.id), diagnostics: run.diagnostics.get(file.id) ?? [] })
    }

    const cacheable = programDiagnostics.length === 0 && ![...run.diagnostics.values()].some(diagnostics =>
      diagnostics.some(diagnostic => diagnostic.category === 'error' && isDeclarationEmitDiagnostic(diagnostic)))
    if (cache && cacheable) {
      await Promise.all(misses.map(async (file) => {
        const { dts, diagnostics } = entries.get(file.id)!
        const key = keys.get(file.id)
        if (dts !== undefined && key !== undefined) {
          await cache.setItem(key, serializeCacheEntry({ dts, diagnostics }))
        }
      }))
    }
  }

  for (const file of emitted) {
    const { dts, diagnostics } = entries.get(file.id)!
    result.diagnostics.push(...diagnostics)
    if (dts === undefined) {
      continue
    }
    result.files.set(declarationPath(file.id), dts)
    if (options.emitLegacyDeclarationAlias && !isScriptFile(file.id)) {
      result.files.set(`${file.id}.d.ts`, dts)
    }
  }
  result.diagnostics.push(...programDiagnostics)
  return result
}
