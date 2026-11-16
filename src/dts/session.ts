import type TypeScript from 'typescript'

import { createHash } from 'node:crypto'

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
 * since the previous one. The session holds the parsed sources of the last
 * call it was passed to, until it is garbage collected.
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
  return {
    wrap(host, options) {
      const optionsKey = createHash('sha256').update(JSON.stringify(options)).digest('hex')
      const getSourceFile = host.getSourceFile.bind(host)
      host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
        const { languageVersion, impliedNodeFormat, jsDocParsingMode } = typeof languageVersionOrOptions === 'object'
          ? languageVersionOrOptions
          : { languageVersion: languageVersionOrOptions } as TypeScript.CreateSourceFileOptions
        const key = [optionsKey, fileName, languageVersion, impliedNodeFormat, jsDocParsingMode].join('\0')
        const cached = previous.get(key) ?? next.get(key)
        if (cached && !shouldCreateNewSourceFile && cached.text === host.readFile(fileName)) {
          next.set(key, cached)
          return cached
        }
        const sourceFile = getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile)
        if (sourceFile) {
          next.set(key, sourceFile)
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
