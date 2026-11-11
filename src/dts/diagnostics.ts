import type TypeScript from 'typescript'

import { normalize, relative } from '../utils/path'

export type DeclarationDiagnosticCategory = 'error' | 'warning' | 'suggestion' | 'message'

/**
 * Where a diagnostic was reported: `syntactic` and `semantic` checks of an
 * emitted file, its `declaration` emit, or the program `options` (reported
 * only when emit was skipped without another explanation).
 */
export type DeclarationDiagnosticKind = 'syntactic' | 'semantic' | 'declaration' | 'options'

export interface DeclarationDiagnostic {
  /** TypeScript diagnostic code, e.g. `2322` for TS2322. */
  code: number
  category: DeclarationDiagnosticCategory
  kind: DeclarationDiagnosticKind
  /** Absolute path of the file the diagnostic is reported in; the `.vue` file for SFCs. */
  file?: string
  /** 1-based line in `file`. */
  line?: number
  /** 1-based column in `file`. */
  column?: number
  message: string
}

const CATEGORIES: Record<TypeScript.DiagnosticCategory, DeclarationDiagnosticCategory> = {
  0: 'warning',
  1: 'error',
  2: 'suggestion',
  3: 'message',
}

// Inferred types that cannot be named or serialized, private names in
// exported declarations, and `isolatedDeclarations` errors.
const DECLARATION_EMIT_CODES = new Set([2527, 2742, 2883, 4118, 5088, 7056])
const DECLARATION_EMIT_RANGES: Array<[number, number]> = [
  [4000, 4103],
  [4106, 4108],
  [9005, 9039],
]

/**
 * Whether a diagnostic means emitted declarations are missing or wrong:
 * syntax errors, declaration emit errors (such as TS2742 "cannot be named"
 * portability errors, the TS4xxx "has or is using private name" family and
 * TS9xxx `isolatedDeclarations` errors), and program option errors that
 * caused emit to be skipped. Other semantic errors, such as type mismatches,
 * leave declarations intact.
 *
 * Pass a diagnostic returned by `emitVueDeclarations`, or a TypeScript
 * diagnostic code. A bare code in the TS1xxx range counts as a syntax error,
 * as only the diagnostic's `kind` tells it apart from a TS1xxx semantic error.
 */
export function isDeclarationEmitDiagnostic(diagnostic: number | Pick<DeclarationDiagnostic, 'code' | 'kind'>): boolean {
  if (typeof diagnostic === 'number') {
    return (diagnostic >= 1000 && diagnostic < 2000) || isDeclarationEmitCode(diagnostic)
  }
  return diagnostic.kind !== 'semantic' || isDeclarationEmitCode(diagnostic.code)
}

function isDeclarationEmitCode(code: number): boolean {
  return DECLARATION_EMIT_CODES.has(code) || DECLARATION_EMIT_RANGES.some(([start, end]) => code >= start && code <= end)
}

export function toDeclarationDiagnostic(
  ts: typeof TypeScript,
  diagnostic: TypeScript.Diagnostic,
  kind: DeclarationDiagnosticKind,
): DeclarationDiagnostic {
  const result: DeclarationDiagnostic = {
    code: diagnostic.code,
    category: CATEGORIES[diagnostic.category],
    kind,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  }
  if (diagnostic.file) {
    result.file = normalize(diagnostic.file.fileName)
    if (diagnostic.start !== undefined) {
      const { line, character } = ts.getLineAndCharacterOfPosition(diagnostic.file, diagnostic.start)
      result.line = line + 1
      result.column = character + 1
    }
  }
  return result
}

export function formatDeclarationDiagnostic(diagnostic: DeclarationDiagnostic, cwd: string): string {
  const location = diagnostic.file
    ? `${relative(cwd, diagnostic.file)}${diagnostic.line === undefined ? '' : `(${diagnostic.line},${diagnostic.column})`}: `
    : ''
  return `${location}${diagnostic.category} TS${diagnostic.code}: ${diagnostic.message}`
}
