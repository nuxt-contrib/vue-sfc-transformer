import type TypeScript from 'typescript'
import type { DtsCache, DtsCacheEntry, DtsCacheManifest, DtsCacheProgramInputs } from './cache'
import type { ProgramInputs } from './dependencies'
import type { DeclarationDiagnostic } from './diagnostics'
import type { DeclarationProject } from './project'
import type { SourceFileReuse, VueDeclarationSession } from './session'
import type { Toolchain } from './toolchain'

import { access, readFile } from 'node:fs/promises'
import process from 'node:process'
import { isDeepStrictEqual } from 'node:util'

import { join, normalize, resolve } from '../utils/path'
import { CACHE_ENTRY_FORMAT, createFileSystemDtsCache, hashSfc, hashText, parseCacheEntry, parseCacheManifest } from './cache'
import { collectProgramInputs, hasSameResolutions } from './dependencies'
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
   * Each declaration is cached with the diagnostics of its source, which are
   * returned again on a hit, and is reused while its source and the files it
   * depends on are unchanged: those it imports and those visible to every
   * source, compared by their declarations when emitted in the same call and
   * by their text otherwise. Files that TypeScript loads from packages in
   * `node_modules` are not compared. Nothing is cached from a run with errors
   * that affect declarations or with program option errors, so they are
   * reported again on the next run.
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
   * parsed by the previous call it was passed to, and to share the
   * declaration files of libraries between the projects of one call.
   */
  session?: VueDeclarationSession
  /**
   * Type check the sources, and report their semantic diagnostics. With
   * `false`, only syntax errors and declaration emit errors are reported,
   * and with TypeScript 5.5 or later (`noCheck`) declarations are emitted
   * without checking each source in full, which is faster. Their members can
   * then be printed in another order. Defaults to `true`.
   */
  typeCheck?: boolean
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
  typeCheck: boolean
}

interface FileRun {
  dts?: string
  /** Diagnostics reported while checking and emitting the file. */
  diagnostics: DeclarationDiagnostic[]
  /** What the result depends on, as cached; unset when it cannot be cached. */
  dependencies?: Record<string, string>
  /** Whether the result is the cached one passed to the runner. */
  cached: boolean
}

interface DeclarationRun {
  files: Map<string, FileRun>
  /** Program option and global diagnostics. */
  programDiagnostics: DeclarationDiagnostic[]
  /** What the programs read, when the results can be cached. */
  inputs?: DtsCacheProgramInputs[]
}

// `files` are emitted, apart from those whose `cached` entry is still
// current; `sources` also includes declaration files, which emitted files may
// import. Without `cached`, results are not cached.
export type VueTscRunner = (
  files: VueDeclarationSource[],
  options: ResolvedEmitOptions,
  sources: VueDeclarationSource[],
  cached: Map<string, DtsCacheEntry> | undefined,
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

const runVueTsc: VueTscRunner = (files, options, sources, cached) => {
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
  const result: DeclarationRun = { files: new Map(), programDiagnostics: [] }
  for (const [project, group] of groups) {
    const roots = sources.filter(file => projectOf(file) === project)
    const run = emitProjectDeclarations(toolchain, options, project, group, sources, roots, reuse, cached)
    for (const [id, file] of run.files) {
      result.files.set(id, file)
    }
    result.programDiagnostics.push(...run.programDiagnostics)
    if (run.inputs) {
      (result.inputs ??= []).push({
        ids: group.map(file => file.id),
        files: Object.fromEntries(run.inputs.files),
        absent: [...run.inputs.absent].sort(),
      })
    }
  }
  for (const project of projects) {
    if (!groups.has(project)) {
      reuse?.retainProgram(programKey(project))
    }
  }
  reuse?.commit()
  return result
}

function programKey(project: DeclarationProject): string {
  return String(project.options.configFilePath ?? '')
}

interface ProjectRun {
  files: Map<string, FileRun>
  programDiagnostics: DeclarationDiagnostic[]
  inputs?: ProgramInputs
}

function emitProjectDeclarations(
  toolchain: Toolchain,
  { rootDir, typeCheck }: ResolvedEmitOptions,
  project: DeclarationProject,
  files: VueDeclarationSource[],
  sources: VueDeclarationSource[],
  roots: VueDeclarationSource[],
  reuse: SourceFileReuse | undefined,
  cached: Map<string, DtsCacheEntry> | undefined,
): ProjectRun {
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
    ...!typeCheck && { noCheck: true },
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
  const sourceFileKeys = reuse?.wrap(tsHost, compilerOptions)

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

  const key = programKey(project)
  const previous = reuse?.previousProgram(key)
  const oldProgram = previous && hasSameResolutions(previous.inputs, fileName => tsHost.fileExists(fileName), fileName => tsHost.readFile(fileName))
    ? previous.program
    : undefined
  const createOptions: TypeScript.CreateProgramOptions = { rootNames, options: compilerOptions, host: tsHost, oldProgram }
  const program = createProgram(createOptions)
  // `@volar/typescript` keeps these options as long as the program, which
  // would keep every earlier program reachable.
  delete createOptions.oldProgram
  try {
    const inputs = cached || reuse ? collectProgramInputs(ts, program, rootDir, fileName => tsHost.readFile(fileName)) : undefined
    if (inputs) {
      reuse?.keepProgram(key, { program, inputs, sourceFiles: sourceFileKeys! })
    }
    const tracked = cached && inputs
    return { ...emitProgramDeclarations(ts, program, files, vfs, typeCheck, tracked, cached), inputs: tracked }
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
  typeCheck: boolean,
  inputs: ProgramInputs | undefined,
  cached: Map<string, DtsCacheEntry> | undefined,
): Omit<ProjectRun, 'inputs'> {
  const results = new Map<string, FileRun>()
  const programDiagnostics: DeclarationDiagnostic[] = []
  let emitSkipped = false
  const byPath = new Map(files.map(file => [normalize(file.id), file]))
  const sourceFiles = new Map<VueDeclarationSource, TypeScript.SourceFile>()
  for (const sourceFile of program.getSourceFiles()) {
    const file = byPath.get(normalize(sourceFile.fileName))
    if (file) {
      sourceFiles.set(file, sourceFile)
    }
  }
  const ordered = [...sourceFiles.keys()]

  const emit = (file: VueDeclarationSource): void => {
    const sourceFile = sourceFiles.get(file)!
    const diagnostics: DeclarationDiagnostic[] = []
    for (const diagnostic of program.getSyntacticDiagnostics(sourceFile)) {
      diagnostics.push(toDeclarationDiagnostic(ts, diagnostic, 'syntactic'))
    }
    for (const diagnostic of typeCheck ? program.getSemanticDiagnostics(sourceFile) : []) {
      diagnostics.push(toDeclarationDiagnostic(ts, diagnostic, 'semantic'))
    }
    const emitResult = program.emit(sourceFile)
    emitSkipped ||= emitResult.emitSkipped
    for (const diagnostic of emitResult.diagnostics) {
      diagnostics.push(toDeclarationDiagnostic(ts, diagnostic, 'declaration'))
    }
    // vue-tsc writes `<path>.vue.d.ts` for SFC inputs
    const dts = vfs.get(normalize(isScriptFile(file.id) ? declarationPath(file.id) : `${file.id}.d.ts`))
    results.set(file.id, { dts, diagnostics, cached: false })
  }

  if (!inputs) {
    ordered.forEach(emit)
  }
  else {
    const dependencies = new Map(ordered.map(file => [file.id, inputs.dependenciesOf(normalize(file.id))]))
    const current = new Map<string, DtsCacheEntry>()
    for (const file of ordered) {
      const entry = cached?.get(file.id)
      const paths = dependencies.get(file.id)!
      if (
        entry
        && Object.keys(entry.dependencies).length === paths.length
        && paths.every(path => byPath.has(path) ? path in entry.dependencies : entry.dependencies[path] === inputs.files.get(path))
      ) {
        current.set(file.id, entry)
      }
    }

    // How TypeScript prints an inferred type can depend on the files checked
    // before it, so files are always emitted in program order, from the
    // first one up to the last one whose entry cannot be reused. An entry is
    // reused while the declarations it was emitted against are unchanged.
    const signature = (path: string): string | undefined => {
      const { id } = byPath.get(path)!
      return results.has(id) ? hashText(results.get(id)!.dts) : current.has(id) ? hashText(current.get(id)!.dts) : undefined
    }
    const isStale = (file: VueDeclarationSource, entry: DtsCacheEntry): boolean => dependencies.get(file.id)!.some((path) => {
      const hash = byPath.has(path) ? signature(path) : undefined
      return hash !== undefined && entry.dependencies[path] !== hash
    })
    let next = 0
    for (;;) {
      for (const file of ordered.slice(next)) {
        const entry = current.get(file.id)
        if (entry && isStale(file, entry)) {
          current.delete(file.id)
        }
      }
      let last = ordered.length - 1
      while (last >= next && current.has(ordered[last]!.id)) {
        last--
      }
      if (last < next) {
        break
      }
      for (; next <= last; next++) {
        emit(ordered[next]!)
      }
    }

    for (const file of ordered) {
      const entry = current.get(file.id)
      const result = results.get(file.id)
      if (!result) {
        results.set(file.id, { ...entry!, cached: true })
        continue
      }
      const paths = dependencies.get(file.id)!
      const known = new Set([normalize(file.id), ...paths])
      if (result.diagnostics.every(diagnostic => diagnostic.file === undefined || known.has(normalize(diagnostic.file)))) {
        result.dependencies = Object.fromEntries(paths.map(path => [path, (byPath.has(path) ? signature(path) : inputs.files.get(path))!]))
      }
      result.cached = !!entry && result.dts === entry.dts && isDeepStrictEqual(result.diagnostics, entry.diagnostics) && isDeepStrictEqual(result.dependencies, entry.dependencies)
    }
  }

  if (emitSkipped && ![...results.values()].some(({ diagnostics }) => diagnostics.some(diagnostic => diagnostic.category === 'error' && isDeclarationEmitDiagnostic(diagnostic)))) {
    for (const diagnostic of [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()]) {
      programDiagnostics.push(toDeclarationDiagnostic(ts, diagnostic, 'options'))
    }
  }
  return { files: results, programDiagnostics }
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
    typeCheck: options.typeCheck ?? true,
  }

  const cache = options.cache === false
    ? undefined
    : options.cache || createFileSystemDtsCache({ dir: join(rootDir, 'node_modules/.cache/vue-sfc-dts') })
  const run = cache
    ? await emitCachedDeclarations(emitted, files, resolved, options.cacheVersion, cache, runner)
    : await runner(emitted, resolved, files, undefined)

  for (const file of emitted) {
    const { dts, diagnostics = [] } = run.files.get(file.id) ?? {}
    result.diagnostics.push(...diagnostics)
    if (dts === undefined) {
      continue
    }
    result.files.set(declarationPath(file.id), dts)
    if (options.emitLegacyDeclarationAlias && !isScriptFile(file.id)) {
      result.files.set(`${file.id}.d.ts`, dts)
    }
  }
  result.diagnostics.push(...run.programDiagnostics)
  return result
}

// Each entry is keyed by the source and id of its file, and holds what its
// declaration was emitted against, which a program checks before reusing it.
// A manifest keyed by the ids of all files records what the program of each
// project read in the last call, so that the entries of a project are reused
// without a program when none of that changed.
async function emitCachedDeclarations(
  emitted: VueDeclarationSource[],
  sources: VueDeclarationSource[],
  resolved: ResolvedEmitOptions,
  cacheVersion: string | undefined,
  cache: DtsCache,
  runner: VueTscRunner,
): Promise<DeclarationRun> {
  const version = [getAutoCacheVersion(resolved), cacheVersion, `entry=${CACHE_ENTRY_FORMAT}`, !resolved.typeCheck && 'typeCheck=false'].filter(Boolean).join('|')
  const keys = new Map(emitted.map(file => [file.id, hashSfc(file.id, file.source, version)]))
  const manifestKey = hashSfc('manifest', sources.map(file => file.id).sort().join('\0'), version)
  // Both `null` (unstorage convention) and `undefined` count as misses.
  const [manifestValue, ...values] = await Promise.all([manifestKey, ...keys.values()].map(key => cache.getItem(key)))
  const cached = new Map<string, DtsCacheEntry>()
  const hashes = new Map<string, string>()
  emitted.forEach((file, index) => {
    const value = values[index]
    const entry = value == null ? undefined : parseCacheEntry(value)
    if (entry) {
      cached.set(file.id, entry)
      hashes.set(file.id, hashText(value!))
    }
  })

  const manifest = manifestValue == null ? undefined : parseCacheManifest(manifestValue)
  const texts = new Map(sources.map(file => [normalize(file.id), file.source]))
  const programs = manifest
    ? (await Promise.all(manifest.programs.map(async program => await isProgramCurrent(program, manifest, hashes, texts) && program))).filter(program => program !== false)
    : []
  const current = new Set(programs.flatMap(program => program.ids))
  const remaining = emitted.filter(file => !current.has(file.id))
  const run: DeclarationRun = remaining.length
    ? await runner(remaining, resolved, sources, cached)
    : { files: new Map(), programDiagnostics: [], inputs: [] }
  for (const id of current) {
    run.files.set(id, { ...cached.get(id)!, cached: true })
  }

  const cacheable = run.programDiagnostics.length === 0 && ![...run.files.values()].some(({ diagnostics }) =>
    diagnostics.some(diagnostic => diagnostic.category === 'error' && isDeclarationEmitDiagnostic(diagnostic)))
  if (!cacheable) {
    return run
  }

  await Promise.all(remaining.map(async (file) => {
    const result = run.files.get(file.id)
    if (!result || result.cached || result.dts === undefined || !result.dependencies) {
      return
    }
    const value = JSON.stringify({ dts: result.dts, diagnostics: result.diagnostics, dependencies: result.dependencies } satisfies DtsCacheEntry)
    hashes.set(file.id, hashText(value))
    await cache.setItem(keys.get(file.id)!, value)
  }))
  if (run.inputs && remaining.length && emitted.every(file => run.files.get(file.id)?.dependencies && hashes.has(file.id))) {
    const entries = Object.fromEntries(emitted.map(file => [file.id, hashes.get(file.id)!]))
    await cache.setItem(manifestKey, JSON.stringify({ entries, programs: [...programs, ...run.inputs] } satisfies DtsCacheManifest))
  }
  return run
}

async function isProgramCurrent(
  program: DtsCacheProgramInputs,
  manifest: DtsCacheManifest,
  hashes: Map<string, string>,
  texts: Map<string, string>,
): Promise<boolean> {
  if (program.ids.some(id => !hashes.has(id) || manifest.entries[id] !== hashes.get(id))) {
    return false
  }
  const checks = await Promise.all([
    ...Object.entries(program.files).map(async ([path, hash]) =>
      hashText(texts.has(path) ? texts.get(path) : await readFile(path, 'utf8').catch(() => undefined)) === hash),
    ...program.absent.map(path => access(path).then(() => false, () => true)),
  ])
  return checks.every(Boolean)
}
