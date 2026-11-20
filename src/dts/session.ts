import type TypeScript from 'typescript'
import type { ProgramInputs } from './dependencies'

declare const brand: unique symbol

/** Parsed sources kept between `emitVueDeclarations` calls. */
export interface VueDeclarationSession {
  readonly [brand]: true
}

interface SessionProgram {
  program: TypeScript.Program
  inputs: ProgramInputs
  /** Keys of the source files the program got from the session. */
  sourceFiles: Set<string>
}

interface SessionState {
  ts?: typeof TypeScript
  sourceFiles: Map<string, TypeScript.SourceFile>
  programs: Map<string, SessionProgram>
}

const states = new WeakMap<VueDeclarationSession, SessionState>()

/**
 * Create a session to pass to repeated `emitVueDeclarations` calls, such as
 * rebuilds in watch mode, so that each call only parses the TypeScript
 * sources (including declarations of the libraries they use) that changed
 * since the previous one. Within one call, the projects referenced by a
 * tsconfig also share the declaration files they have in common, so a session
 * speeds up a single call with several projects too. The next call also
 * reuses the module resolutions of the last one. The session holds the parsed
 * sources and programs of the last call it was passed to, until it is garbage
 * collected.
 */
export function createVueDeclarationSession(): VueDeclarationSession {
  const session = Object.freeze({}) as VueDeclarationSession
  states.set(session, { sourceFiles: new Map(), programs: new Map() })
  return session
}

export interface SourceFileReuse {
  /** Serves the source files of `host` from the session, and returns their keys. */
  wrap: (host: TypeScript.CompilerHost, options: TypeScript.CompilerOptions) => Set<string>
  /** The program of the project with `key` in the last call. */
  previousProgram: (key: string) => SessionProgram | undefined
  keepProgram: (key: string, program: SessionProgram) => void
  /** Keeps the program of the project with `key` from the last call, with its source files. */
  retainProgram: (key: string) => void
  commit: () => void
}

export function reuseSourceFiles(session: VueDeclarationSession, ts: typeof TypeScript): SourceFileReuse {
  const state = states.get(session)!
  const previous = state.ts === ts ? state.sourceFiles : new Map<string, TypeScript.SourceFile>()
  const next = new Map<string, TypeScript.SourceFile>()
  const programs = new Map<string, SessionProgram>()
  const registry = ts.createDocumentRegistry()
  const shareDeclarationFiles = canShareDeclarationFiles(ts)
  return {
    wrap(host, options) {
      const optionsKey = sourceFileOptionsKey(registry, options)
      const used = new Set<string>()
      const getSourceFile = host.getSourceFile.bind(host)
      host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
        const createOptions: TypeScript.CreateSourceFileOptions = typeof languageVersionOrOptions === 'object'
          ? languageVersionOrOptions
          : { languageVersion: languageVersionOrOptions }
        const { languageVersion, impliedNodeFormat, jsDocParsingMode, setExternalModuleIndicator } = createOptions
        const fileKey = [fileName, languageVersion, impliedNodeFormat, jsDocParsingMode].join('\0')
        const declarationKey = shareDeclarationFiles && setExternalModuleIndicator ? `\0${fileKey}` : undefined
        const key = `${optionsKey}\0${fileKey}`
        if (!shouldCreateNewSourceFile) {
          const declaration = declarationKey === undefined ? undefined : next.get(declarationKey) ?? previous.get(declarationKey)
          if (declaration && hasModuleIndicator(declaration, setExternalModuleIndicator!) && declaration.text === host.readFile(fileName)) {
            next.set(declarationKey!, declaration)
            used.add(declarationKey!)
            return declaration
          }
          const cached = next.get(key) ?? previous.get(key)
          if (cached && cached.text === host.readFile(fileName)) {
            next.set(key, cached)
            used.add(key)
            return cached
          }
        }
        const sourceFile = getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile)
        if (sourceFile) {
          const sourceFileKey = declarationKey !== undefined && sourceFile.isDeclarationFile ? declarationKey : key
          next.set(sourceFileKey, sourceFile)
          used.add(sourceFileKey)
        }
        return sourceFile
      }
      return used
    },
    previousProgram: key => state.ts === ts ? state.programs.get(key) : undefined,
    keepProgram(key, program) {
      programs.set(key, program)
    },
    retainProgram(key) {
      const program = state.ts === ts ? state.programs.get(key) : undefined
      if (!program || programs.has(key)) {
        return
      }
      programs.set(key, program)
      for (const sourceFileKey of program.sourceFiles) {
        if (!next.has(sourceFileKey) && previous.has(sourceFileKey)) {
          next.set(sourceFileKey, previous.get(sourceFileKey)!)
        }
      }
    },
    commit() {
      state.ts = ts
      state.sourceFiles = next
      state.programs = programs
    },
  }
}

// Declaration files are also shared between programs whose options parse
// other files differently. Of those options, only the target and module
// format (part of each key) and whether the file is a module (compared on
// reuse) apply to declaration files. Before TypeScript 5.3, source files hold
// the module resolutions of the program that created them.
function canShareDeclarationFiles(ts: typeof TypeScript): boolean {
  const [major = 0, minor = 0] = ts.versionMajorMinor.split('.').map(Number)
  return major > 5 || (major === 5 && minor >= 3)
}

function hasModuleIndicator(sourceFile: TypeScript.SourceFile, setExternalModuleIndicator: (file: TypeScript.SourceFile) => void): boolean {
  const probe = Object.create(sourceFile) as TypeScript.SourceFile & { externalModuleIndicator?: unknown }
  setExternalModuleIndicator(probe)
  return probe.externalModuleIndicator === (sourceFile as typeof probe).externalModuleIndicator
}

// Other source files are shared between programs whose options parse and bind
// them the same way, as the TypeScript language service shares them between
// projects. `shouldPreserveConstEnums()` also changes which statements the
// binder reports as unreachable.
function sourceFileOptionsKey(registry: TypeScript.DocumentRegistry, options: TypeScript.CompilerOptions): string {
  return [
    registry.getKeyForCompilationSettings(options),
    options.preserveConstEnums,
    options.isolatedModules,
    options.verbatimModuleSyntax,
  ].join('\0')
}
