import type TypeScript from 'typescript'
import type { DtsCache } from './cache'
import type { DeclarationDiagnostic } from './diagnostics'
import type { DeclarationProject } from './project'
import type { Toolchain } from './toolchain'

import process from 'node:process'

import { join, normalize, resolve } from '../utils/path'
import { createFileSystemDtsCache, hashSfc, hashSources } from './cache'
import { isDeclarationEmitDiagnostic, toDeclarationDiagnostic } from './diagnostics'
import { resolveDeclarationProjects } from './project'
import { loadToolchain } from './toolchain'
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
   * Nothing is cached from a run with errors, so they are reported again on
   * the next run.
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
}

interface DeclarationRun {
  declarations: Map<string, string>
  diagnostics: DeclarationDiagnostic[]
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

  const declarations = new Map<string, string>()
  const diagnostics: DeclarationDiagnostic[] = []
  for (const [project, group] of groups) {
    const roots = sources.filter(file => projectOf(file) === project)
    const run = emitProjectDeclarations(toolchain, project, group, sources, roots)
    for (const [id, dts] of run.declarations) {
      declarations.set(id, dts)
    }
    diagnostics.push(...run.diagnostics)
  }
  return { declarations, diagnostics }
}

function emitProjectDeclarations(
  { ts, volarTs, vueLanguageCore }: Toolchain,
  project: DeclarationProject,
  files: VueDeclarationSource[],
  sources: VueDeclarationSource[],
  roots: VueDeclarationSource[],
): DeclarationRun {
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

  const rootNames = [...new Set([...project.fileNames, ...roots.map(f => normalize(f.id)).sort()])]
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
  const diagnostics: DeclarationDiagnostic[] = []
  let emitSkipped = false
  const emitted = new Set(files.map(file => normalize(file.id)))
  for (const sourceFile of program.getSourceFiles()) {
    if (!emitted.has(normalize(sourceFile.fileName))) {
      continue
    }
    for (const diagnostic of program.getSyntacticDiagnostics(sourceFile)) {
      diagnostics.push(toDeclarationDiagnostic(ts, diagnostic, 'syntactic'))
    }
    for (const diagnostic of program.getSemanticDiagnostics(sourceFile)) {
      diagnostics.push(toDeclarationDiagnostic(ts, diagnostic, 'semantic'))
    }
    const emitResult = program.emit(sourceFile)
    emitSkipped ||= emitResult.emitSkipped
    for (const diagnostic of emitResult.diagnostics) {
      diagnostics.push(toDeclarationDiagnostic(ts, diagnostic, 'declaration'))
    }
  }
  if (emitSkipped && !diagnostics.some(diagnostic => diagnostic.category === 'error' && isDeclarationEmitDiagnostic(diagnostic))) {
    for (const diagnostic of [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()]) {
      diagnostics.push(toDeclarationDiagnostic(ts, diagnostic, 'options'))
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
  return { declarations, diagnostics }
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
  }

  const declarations = new Map<string, string>()
  const cache = options.cache === false
    ? undefined
    : options.cache || createFileSystemDtsCache({ dir: join(rootDir, 'node_modules/.cache/vue-sfc-dts') })
  const version = cache
    ? [getAutoCacheVersion(resolved), options.cacheVersion, `sources=${hashSources(files)}`].filter(Boolean).join('|')
    : ''

  const keys = new Map<string, string>()
  if (cache) {
    await Promise.all(emitted.map(async (file) => {
      const key = hashSfc(file.id, file.source, version)
      keys.set(file.id, key)
      const hit = await cache.getItem(key)
      // Both `null` (unstorage convention) and `undefined` count as misses.
      if (hit != null) {
        declarations.set(file.id, hit)
      }
    }))
  }
  const misses = emitted.filter(file => !declarations.has(file.id))

  if (misses.length) {
    const run = await runner(misses, resolved, files)
    result.diagnostics = run.diagnostics
    for (const [id, dts] of run.declarations) {
      declarations.set(id, dts)
    }

    if (cache && !run.diagnostics.some(diagnostic => diagnostic.category === 'error')) {
      await Promise.all(misses.map(async (file) => {
        const dts = run.declarations.get(file.id)
        const key = keys.get(file.id)
        if (dts !== undefined && key !== undefined) {
          await cache.setItem(key, dts)
        }
      }))
    }
  }

  for (const file of emitted) {
    const dts = declarations.get(file.id)
    if (dts === undefined) {
      continue
    }
    result.files.set(declarationPath(file.id), dts)
    if (options.emitLegacyDeclarationAlias && !isScriptFile(file.id)) {
      result.files.set(`${file.id}.d.ts`, dts)
    }
  }
  return result
}
