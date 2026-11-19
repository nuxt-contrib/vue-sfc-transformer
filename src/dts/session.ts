import type TypeScript from 'typescript'

declare const brand: unique symbol

/** Parsed sources kept between `emitVueDeclarations` calls. */
export interface VueDeclarationSession {
  readonly [brand]: true
}

interface SessionState {
  ts?: typeof TypeScript
  sourceFiles: Map<string, TypeScript.SourceFile>
}

const states = new WeakMap<VueDeclarationSession, SessionState>()

/**
 * Create a session to pass to repeated `emitVueDeclarations` calls, such as
 * rebuilds in watch mode, so that each call only parses the TypeScript
 * sources (including declarations of the libraries they use) that changed
 * since the previous one. Within one call, the projects referenced by a
 * tsconfig also share the declaration files they have in common, so a session
 * speeds up a single call with several projects too. The session holds the
 * parsed sources of the last call it was passed to, until it is garbage
 * collected.
 */
export function createVueDeclarationSession(): VueDeclarationSession {
  const session = Object.freeze({}) as VueDeclarationSession
  states.set(session, { sourceFiles: new Map() })
  return session
}

export interface SourceFileReuse {
  wrap: (host: TypeScript.CompilerHost, options: TypeScript.CompilerOptions) => void
  commit: () => void
}

export function reuseSourceFiles(session: VueDeclarationSession, ts: typeof TypeScript): SourceFileReuse {
  const state = states.get(session)!
  const previous = state.ts === ts ? state.sourceFiles : new Map<string, TypeScript.SourceFile>()
  const next = new Map<string, TypeScript.SourceFile>()
  const registry = ts.createDocumentRegistry()
  const shareDeclarationFiles = canShareDeclarationFiles(ts)
  return {
    wrap(host, options) {
      const optionsKey = sourceFileOptionsKey(registry, options)
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
          const declaration = declarationKey === undefined ? undefined : previous.get(declarationKey) ?? next.get(declarationKey)
          if (declaration && hasModuleIndicator(declaration, setExternalModuleIndicator!) && declaration.text === host.readFile(fileName)) {
            next.set(declarationKey!, declaration)
            return declaration
          }
          const cached = previous.get(key) ?? next.get(key)
          if (cached && cached.text === host.readFile(fileName)) {
            next.set(key, cached)
            return cached
          }
        }
        const sourceFile = getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile)
        if (sourceFile) {
          next.set(declarationKey !== undefined && sourceFile.isDeclarationFile ? declarationKey : key, sourceFile)
        }
        return sourceFile
      }
    },
    commit() {
      state.ts = ts
      state.sourceFiles = next
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
