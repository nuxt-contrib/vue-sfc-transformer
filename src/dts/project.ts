import type { VueCompilerOptions } from '@vue/language-core'
import type TypeScript from 'typescript'
import type { Toolchain } from './toolchain'

import { dirname, normalize } from '../utils/path'
import { readTsconfigJson } from './tsconfig'

export interface DeclarationProject {
  options: TypeScript.CompilerOptions
  fileNames: string[]
  vueOptions: VueCompilerOptions
}

export function resolveDeclarationProjects(
  toolchain: Toolchain,
  rootDir: string,
  tsconfig: string | undefined,
  paths?: Record<string, string[]>,
): DeclarationProject[] {
  const { ts, vueLanguageCore } = toolchain
  const projects: DeclarationProject[] = []
  if (tsconfig) {
    collectProjects(toolchain, normalize(tsconfig), projects, new Set())
  }
  else {
    const { vueOptions } = vueLanguageCore.createParsedCommandLineByJson(ts, ts.sys, rootDir, {})
    const options: TypeScript.CompilerOptions = {
      allowJs: true,
      allowImportingTsExtensions: true,
      noUncheckedSideEffectImports: false,
      skipLibCheck: true,
      strictNullChecks: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    }
    projects.push({ options, fileNames: [], vueOptions })
  }
  if (paths) {
    for (const project of projects) {
      project.options = { ...project.options, paths: { ...project.options.paths, ...paths } }
    }
  }
  return projects
}

function collectProjects(toolchain: Toolchain, tsconfig: string, projects: DeclarationProject[], seen: Set<string>): void {
  if (seen.has(tsconfig)) {
    return
  }
  seen.add(tsconfig)

  const { ts, vueLanguageCore } = toolchain
  const json = readTsconfigJson(ts, tsconfig)
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
      collectProjects(toolchain, normalize(ts.resolveProjectReferencePath(reference)), projects, seen)
    }
    return
  }
  projects.push({ options: parsed.options, fileNames: parsed.fileNames.map(normalize), vueOptions })
}
