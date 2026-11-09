import type { VueCompilerOptions } from '@vue/language-core'

import * as vueLanguageCore from '@vue/language-core'
import ts from 'typescript'

import { dirname, normalize } from '../utils/path'
import { readTsconfigJson } from './tsconfig'

export interface DeclarationProject {
  options: ts.CompilerOptions
  fileNames: string[]
  vueOptions: VueCompilerOptions
}

const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  allowImportingTsExtensions: true,
  noUncheckedSideEffectImports: false,
  skipLibCheck: true,
  strictNullChecks: true,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
}

export function resolveDeclarationProjects(
  rootDir: string,
  tsconfig: string | undefined,
  paths?: Record<string, string[]>,
): DeclarationProject[] {
  const projects: DeclarationProject[] = []
  if (tsconfig) {
    collectProjects(normalize(tsconfig), projects, new Set())
  }
  else {
    const { vueOptions } = vueLanguageCore.createParsedCommandLineByJson(ts, ts.sys, rootDir, {})
    projects.push({ options: DEFAULT_COMPILER_OPTIONS, fileNames: [], vueOptions })
  }
  if (paths) {
    for (const project of projects) {
      project.options = { ...project.options, paths: { ...project.options.paths, ...paths } }
    }
  }
  return projects
}

function collectProjects(tsconfig: string, projects: DeclarationProject[], seen: Set<string>): void {
  if (seen.has(tsconfig)) {
    return
  }
  seen.add(tsconfig)

  const json = readTsconfigJson(tsconfig)
  const basePath = dirname(tsconfig)
  const { vueOptions } = vueLanguageCore.createParsedCommandLineByJson(ts, ts.sys, basePath, json, tsconfig)
  const extraFileExtensions = vueLanguageCore.getAllExtensions(vueOptions).map(extension => ({
    extension: extension.slice(1),
    isMixedContent: true,
    scriptKind: ts.ScriptKind.Deferred,
  }))
  const parsed = ts.parseJsonConfigFileContent(json, ts.sys, basePath, undefined, tsconfig, undefined, extraFileExtensions)

  if (parsed.fileNames.length === 0 && parsed.projectReferences?.length) {
    for (const reference of parsed.projectReferences) {
      collectProjects(normalize(ts.resolveProjectReferencePath(reference)), projects, seen)
    }
    return
  }
  projects.push({ options: parsed.options, fileNames: parsed.fileNames.map(normalize), vueOptions })
}
