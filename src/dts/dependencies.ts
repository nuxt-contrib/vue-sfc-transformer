import type TypeScript from 'typescript'

import { dirname, isAbsolute, join, normalize } from '../utils/path'
import { hashText } from './cache'

interface Resolution {
  resolvedModule?: { resolvedFileName: string }
  resolvedTypeReferenceDirective?: { resolvedFileName?: string }
  failedLookupLocations?: string[]
  affectingLocations?: string[]
}

// Available on programs since TypeScript 5.3.
interface ProgramResolutions {
  forEachResolvedModule?: (callback: (resolution: Resolution) => void, file?: TypeScript.SourceFile) => void
  forEachResolvedTypeReferenceDirective?: (callback: (resolution: Resolution) => void, file?: TypeScript.SourceFile) => void
}

export interface ProgramInputs {
  /**
   * Hashes of the files the program read that can change between builds,
   * keyed by path: those outside `node_modules` (or reached other than as a
   * package), and the `package.json` files outside `node_modules` that module
   * resolution read.
   */
  files: Map<string, string>
  /**
   * Paths outside `node_modules` that module resolution looked up and did not
   * find, where a new file would change how a module resolves.
   */
  absent: Set<string>
  /**
   * The tracked files whose declarations a source can depend on: those it
   * imports or references, directly or not, and those visible to every
   * source (global scripts, global and module augmentations, and the files
   * they import), apart from the source itself.
   */
  dependenciesOf: (fileName: string) => string[]
}

const NODE_MODULES_RE = /[\\/]node_modules[\\/]/
const REFERENCE_EXTENSIONS = ['', '.ts', '.tsx', '.d.ts']

export function collectProgramInputs(
  ts: typeof TypeScript,
  program: TypeScript.Program,
  readFile: (fileName: string) => string | undefined,
): ProgramInputs {
  const resolutions = program as TypeScript.Program & ProgramResolutions
  const canResolve = typeof resolutions.forEachResolvedModule === 'function' && typeof resolutions.forEachResolvedTypeReferenceDirective === 'function'
  const preserveSymlinks = program.getCompilerOptions().preserveSymlinks
  const isPackageFile = (sourceFile: TypeScript.SourceFile): boolean => {
    const fileName = preserveSymlinks ? ts.sys.realpath?.(sourceFile.fileName) ?? sourceFile.fileName : sourceFile.fileName
    return NODE_MODULES_RE.test(fileName) && program.isSourceFileFromExternalLibrary(sourceFile)
  }

  const files = new Map<string, string>()
  const absent = new Set<string>()
  const tracked = new Set<TypeScript.SourceFile>()
  const edges = new Map<TypeScript.SourceFile, Array<TypeScript.SourceFile | undefined>>()
  const globals: TypeScript.SourceFile[] = []

  const addLookups = (resolution: Resolution): void => {
    for (const location of resolution.failedLookupLocations ?? []) {
      if (!NODE_MODULES_RE.test(location)) {
        absent.add(normalize(location))
      }
    }
    for (const location of resolution.affectingLocations ?? []) {
      if (!NODE_MODULES_RE.test(location)) {
        files.set(normalize(location), hashText(readFile(location)))
      }
    }
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (!program.isSourceFileDefaultLibrary(sourceFile) && !isPackageFile(sourceFile)) {
      tracked.add(sourceFile)
      files.set(normalize(sourceFile.fileName), hashText(readFile(sourceFile.fileName)))
    }
    if (affectsGlobalScope(ts, sourceFile)) {
      globals.push(sourceFile)
    }

    // `undefined` stands for a dependency that could not be found, so that
    // the sources reaching it depend on every tracked file.
    const targets: Array<TypeScript.SourceFile | undefined> = []
    if (canResolve) {
      resolutions.forEachResolvedModule!((resolution) => {
        addLookups(resolution)
        const target = resolution.resolvedModule && program.getSourceFile(resolution.resolvedModule.resolvedFileName)
        if (target) {
          targets.push(target)
        }
      }, sourceFile)
      resolutions.forEachResolvedTypeReferenceDirective!((resolution) => {
        addLookups(resolution)
        const fileName = resolution.resolvedTypeReferenceDirective?.resolvedFileName
        const target = fileName && program.getSourceFile(fileName)
        if (target) {
          targets.push(target)
        }
      }, sourceFile)
    }
    else {
      targets.push(undefined)
    }
    for (const reference of sourceFile.referencedFiles) {
      const path = isAbsolute(reference.fileName) ? reference.fileName : join(dirname(sourceFile.fileName), reference.fileName)
      targets.push(REFERENCE_EXTENSIONS.map(extension => program.getSourceFile(`${path}${extension}`)).find(Boolean))
    }
    edges.set(sourceFile, targets)
  }

  const reachable = reachableTrackedFiles(edges, tracked)
  const union = (sourceFiles: TypeScript.SourceFile[]): Set<string> | undefined => {
    const names = new Set<string>()
    for (const sourceFile of sourceFiles) {
      const reached = reachable.get(sourceFile)
      if (!reached) {
        return undefined
      }
      for (const name of reached) {
        names.add(name)
      }
    }
    return names
  }

  const all = [...tracked].map(sourceFile => normalize(sourceFile.fileName)).sort()
  const global = union(globals)
  return {
    files,
    absent,
    dependenciesOf(fileName) {
      const sourceFile = program.getSourceFile(fileName)
      const local = sourceFile && global && union([sourceFile])
      const names = local ? [...new Set([...global!, ...local])].sort() : all
      return names.filter(name => name !== normalize(fileName))
    },
  }
}

// The names of the tracked files reachable from each file, or `undefined`
// when that includes a dependency that could not be found. Each strongly
// connected component of the graph is resolved once, after the components
// it reaches (Tarjan's algorithm).
function reachableTrackedFiles(
  edges: Map<TypeScript.SourceFile, Array<TypeScript.SourceFile | undefined>>,
  tracked: Set<TypeScript.SourceFile>,
): Map<TypeScript.SourceFile, Set<string> | undefined> {
  const reachable = new Map<TypeScript.SourceFile, Set<string> | undefined>()
  const index = new Map<TypeScript.SourceFile, number>()
  const low = new Map<TypeScript.SourceFile, number>()
  const stack: TypeScript.SourceFile[] = []
  const onStack = new Set<TypeScript.SourceFile>()
  const enter = (sourceFile: TypeScript.SourceFile): void => {
    index.set(sourceFile, index.size)
    low.set(sourceFile, index.get(sourceFile)!)
    stack.push(sourceFile)
    onStack.add(sourceFile)
  }

  for (const root of edges.keys()) {
    if (index.has(root)) {
      continue
    }
    enter(root)
    const work: Array<[TypeScript.SourceFile, number]> = [[root, 0]]
    while (work.length) {
      const frame = work.at(-1)!
      const [sourceFile, next] = frame
      const targets = edges.get(sourceFile) ?? []
      if (next < targets.length) {
        frame[1]++
        const target = targets[next]
        if (target && !index.has(target)) {
          enter(target)
          work.push([target, 0])
        }
        else if (target && onStack.has(target)) {
          low.set(sourceFile, Math.min(low.get(sourceFile)!, index.get(target)!))
        }
        continue
      }
      work.pop()
      const parent = work.at(-1)?.[0]
      if (parent) {
        low.set(parent, Math.min(low.get(parent)!, low.get(sourceFile)!))
      }
      if (low.get(sourceFile) !== index.get(sourceFile)) {
        continue
      }

      const members: TypeScript.SourceFile[] = []
      let member: TypeScript.SourceFile
      do {
        member = stack.pop()!
        onStack.delete(member)
        members.push(member)
      } while (member !== sourceFile)
      const component = new Set(members)
      const own = members.filter(item => tracked.has(item)).map(item => normalize(item.fileName))
      const reached = new Set<Set<string>>()
      let unknown = false
      for (const item of members) {
        for (const target of edges.get(item) ?? []) {
          if (!target || (!component.has(target) && !reachable.get(target))) {
            unknown = true
          }
          else if (!component.has(target)) {
            reached.add(reachable.get(target)!)
          }
        }
      }
      let names: Set<string> | undefined
      if (!unknown) {
        const sets = [...reached]
        if (own.length === 0 && sets.length === 1) {
          names = sets[0]
        }
        else {
          names = new Set(own)
          for (const set of sets) {
            for (const name of set) {
              names.add(name)
            }
          }
        }
      }
      for (const item of members) {
        reachable.set(item, names)
      }
    }
  }
  return reachable
}

// Whether a file declares anything outside its own module scope.
function affectsGlobalScope(ts: typeof TypeScript, sourceFile: TypeScript.SourceFile): boolean {
  if (sourceFile.fileName.endsWith('.json')) {
    return false
  }
  return !ts.isExternalModule(sourceFile) || sourceFile.statements.some(statement =>
    ts.isModuleDeclaration(statement) && (ts.isStringLiteral(statement.name) || (statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0))
}
