import type { CompilerOptions, ResolutionMode, SourceFile } from 'typescript'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { createVueDeclarationSession, reuseSourceFiles } from '../src/dts/session'

describe('reuseSourceFiles', () => {
  const options: CompilerOptions = { target: ts.ScriptTarget.ESNext }

  function run(
    session = createVueDeclarationSession(),
    files: Record<string, string>,
    { compilerOptions = options, typescript = ts, impliedNodeFormat = ts.ModuleKind.ESNext as ResolutionMode, shouldCreateNewSourceFile = false } = {},
  ): Record<string, SourceFile | undefined> {
    const reuse = reuseSourceFiles(session, typescript)
    const host = ts.createCompilerHost(compilerOptions)
    host.readFile = fileName => files[fileName]
    reuse.wrap(host, compilerOptions)
    const sourceFiles = Object.fromEntries(Object.keys(files).map(fileName => [
      fileName,
      host.getSourceFile(fileName, { languageVersion: ts.ScriptTarget.ESNext, impliedNodeFormat }, undefined, shouldCreateNewSourceFile),
    ]))
    reuse.commit()
    return sourceFiles
  }

  it('reuses unchanged source files from the previous call', () => {
    const session = createVueDeclarationSession()
    const first = run(session, { '/a.ts': 'export const a = 1\n', '/b.ts': 'export const b = 1\n' })
    const second = run(session, { '/a.ts': 'export const a = 1\n', '/b.ts': 'export const b = 2\n' })
    expect(second['/a.ts']).toBe(first['/a.ts'])
    expect(second['/b.ts']).not.toBe(first['/b.ts'])
    expect(second['/b.ts']!.text).toBe('export const b = 2\n')
  })

  it('does not reuse source files across sessions', () => {
    const files = { '/a.ts': 'export const a = 1\n' }
    expect(run(undefined, files)['/a.ts']).not.toBe(run(undefined, files)['/a.ts'])
  })

  it('does not reuse source files parsed with other compiler options', () => {
    const session = createVueDeclarationSession()
    const files = { '/a.ts': 'export const a = 1\n' }
    const first = run(session, files)
    expect(run(session, files, { compilerOptions: { ...options, strict: true } })['/a.ts']).not.toBe(first['/a.ts'])
  })

  it('does not reuse source files parsed for another module format', () => {
    const session = createVueDeclarationSession()
    const files = { '/a.ts': 'export const a = 1\n' }
    const first = run(session, files)
    expect(run(session, files, { impliedNodeFormat: ts.ModuleKind.CommonJS })['/a.ts']).not.toBe(first['/a.ts'])
  })

  it('parses source files again when asked for a new one', () => {
    const session = createVueDeclarationSession()
    const files = { '/a.ts': 'export const a = 1\n' }
    const first = run(session, files)
    expect(run(session, files, { shouldCreateNewSourceFile: true })['/a.ts']).not.toBe(first['/a.ts'])
  })

  it('does not reuse source files parsed by another TypeScript', () => {
    const session = createVueDeclarationSession()
    const files = { '/a.ts': 'export const a = 1\n' }
    const first = run(session, files)
    expect(run(session, files, { typescript: { ...ts } })['/a.ts']).not.toBe(first['/a.ts'])
  })

  it('only keeps the source files of the last call', () => {
    const session = createVueDeclarationSession()
    const first = run(session, { '/a.ts': 'export const a = 1\n' })
    run(session, { '/b.ts': 'export const b = 1\n' })
    expect(run(session, { '/a.ts': 'export const a = 1\n' })['/a.ts']).not.toBe(first['/a.ts'])
  })
})
