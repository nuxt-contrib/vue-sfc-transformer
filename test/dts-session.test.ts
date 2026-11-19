import type { CompilerOptions, ResolutionMode, SourceFile } from 'typescript'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { createVueDeclarationSession, reuseSourceFiles } from '../src/dts/session'

describe('reuseSourceFiles', () => {
  const options: CompilerOptions = { target: ts.ScriptTarget.ESNext }

  function run(
    session = createVueDeclarationSession(),
    files: Record<string, string>,
    {
      compilerOptions = options,
      typescript = ts,
      languageVersion = ts.ScriptTarget.ESNext,
      impliedNodeFormat = ts.ModuleKind.ESNext as ResolutionMode,
      setExternalModuleIndicator = (file: SourceFile) => void ((file as { externalModuleIndicator?: unknown }).externalModuleIndicator = file.statements.find(ts.isExportDeclaration)),
      shouldCreateNewSourceFile = false,
    } = {},
  ): Record<string, SourceFile | undefined> {
    const reuse = reuseSourceFiles(session, typescript)
    const host = ts.createCompilerHost(compilerOptions)
    host.readFile = fileName => files[fileName]
    reuse.wrap(host, compilerOptions)
    const sourceFiles = Object.fromEntries(Object.keys(files).map(fileName => [
      fileName,
      host.getSourceFile(fileName, { languageVersion, impliedNodeFormat, setExternalModuleIndicator }, undefined, shouldCreateNewSourceFile),
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

  it('reuses source files parsed with options that do not affect parsing', () => {
    const session = createVueDeclarationSession()
    const files = { '/a.ts': 'export const a = 1\n' }
    const first = run(session, files)
    const compilerOptions = { ...options, lib: ['lib.dom.d.ts'], types: ['node'], strictNullChecks: true, paths: { '#a': ['./a.ts'] } }
    expect(run(session, files, { compilerOptions })['/a.ts']).toBe(first['/a.ts'])
  })

  it.each<[string, CompilerOptions]>([
    ['alwaysStrict', { alwaysStrict: true }],
    ['module', { module: ts.ModuleKind.Preserve }],
    ['jsx', { jsx: ts.JsxEmit.ReactJSX }],
    ['preserveConstEnums', { preserveConstEnums: true }],
    ['isolatedModules', { isolatedModules: true }],
  ])('does not reuse source files parsed with another `%s`', (_, compilerOptions) => {
    const session = createVueDeclarationSession()
    const files = { '/a.ts': 'export const a = 1\n' }
    const first = run(session, files)
    expect(run(session, files, { compilerOptions: { ...options, ...compilerOptions } })['/a.ts']).not.toBe(first['/a.ts'])
  })

  it('reuses declaration files parsed with options that only affect other files', () => {
    const session = createVueDeclarationSession()
    const files = { '/a.d.ts': 'export declare const a: 1\n', '/global.d.ts': 'declare const g: 1\n' }
    const first = run(session, files)
    const second = run(session, files, { compilerOptions: { ...options, module: ts.ModuleKind.Preserve, moduleDetection: ts.ModuleDetectionKind.Force, alwaysStrict: true, jsx: ts.JsxEmit.ReactJSX } })
    expect(second['/a.d.ts']).toBe(first['/a.d.ts'])
    expect(second['/global.d.ts']).toBe(first['/global.d.ts'])
  })

  it('does not reuse declaration files parsed for another target', () => {
    const session = createVueDeclarationSession()
    const files = { '/a.d.ts': 'export declare const a: 1\n' }
    const first = run(session, files)
    expect(run(session, files, { languageVersion: ts.ScriptTarget.ES2015 })['/a.d.ts']).not.toBe(first['/a.d.ts'])
  })

  it('does not reuse declaration files that would be bound as another kind of module', () => {
    const session = createVueDeclarationSession()
    const files = { '/global.d.ts': 'declare const g: 1\n' }
    const first = run(session, files)
    const second = run(session, files, {
      compilerOptions: { ...options, moduleDetection: ts.ModuleDetectionKind.Force },
      setExternalModuleIndicator: file => void ((file as { externalModuleIndicator?: unknown }).externalModuleIndicator = true),
    })
    expect(second['/global.d.ts']).not.toBe(first['/global.d.ts'])
    expect(run(session, files)['/global.d.ts']).not.toBe(second['/global.d.ts'])
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
