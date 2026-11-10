import type { Toolchain } from './toolchain'
import { createHash } from 'node:crypto'

import { createRequire } from 'node:module'

import { resolveDeclarationProjects } from './project'
import { loadToolchain } from './toolchain'

const require = createRequire(import.meta.url)

interface VersionInputs {
  rootDir: string
  // Absolute path to a tsconfig.json whose compiler options and
  // `vueCompilerOptions` (incl. any `extends` chain and references) should be
  // mixed into the hash. Omit to hash the defaults.
  tsconfig?: string
  paths?: Record<string, string[]>
}

const cache = new Map<string, string>()

// Compute a cache-key prefix that captures every input to the emitted .d.ts
// output that lives *outside* the SFC source itself: this package, the Vue
// language plugin, the Volar program proxy, the TypeScript compiler, and the
// resolved compiler options and `vueCompilerOptions` (including any `extends`
// chain from the consumer's tsconfig).
export function getAutoCacheVersion(inputs: VersionInputs): string {
  const memoKey = `${inputs.rootDir}\0${inputs.tsconfig ?? ''}\0${JSON.stringify(inputs.paths ?? {})}`
  const cached = cache.get(memoKey)
  if (cached !== undefined) {
    return cached
  }

  const toolchain = loadToolchain(inputs.rootDir)
  const parts: string[] = [
    `vue-sfc-transformer=${readSelfVersion()}`,
    `@vue/language-core=${toolchain.versions['@vue/language-core']}`,
    `@volar/typescript=${toolchain.versions['@volar/typescript']}`,
    `typescript=${toolchain.versions.typescript}`,
    ...hashProjects(toolchain, inputs),
  ]
  const computed = parts.join('|')
  cache.set(memoKey, computed)
  return computed
}

let selfVersion: string | undefined
function readSelfVersion(): string {
  if (selfVersion !== undefined) {
    return selfVersion
  }
  // In published form we live under `node_modules/vue-sfc-transformer/dist/`,
  // and our own `package.json` sits one level above the entry. In a vitest
  // src-aliased context we live in `src/dts/` so the same `../../package.json`
  // resolves. Read it via the URL so we don't rely on `require.resolve`
  // walking up via `exports`.
  try {
    const url = new URL('../../package.json', import.meta.url)
    const pkg = require(url.pathname) as { version?: string }
    selfVersion = pkg.version ?? 'unknown'
  }
  catch {
    selfVersion = 'unknown'
  }
  return selfVersion
}

function hashProjects(toolchain: Toolchain, inputs: VersionInputs): string[] {
  try {
    const projects = resolveDeclarationProjects(toolchain, inputs.rootDir, inputs.tsconfig, inputs.paths)
    return [
      `vueCompilerOptions=${hash(projects.map(project => project.vueOptions))}`,
      `compilerOptions=${hash(projects.map(project => project.options))}`,
    ]
  }
  catch {
    // If we can't compute the hash (bad tsconfig path that escaped
    // validation, etc.), don't take the whole build down; fall back to a
    // constant so the rest of the auto-version still does its job.
    return ['vueCompilerOptions=unknown', 'compilerOptions=unknown']
  }
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, replacer)).digest('hex').slice(0, 16)
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'function') {
    return `[fn:${value.name || 'anonymous'}]`
  }
  if (value instanceof RegExp) {
    return value.toString()
  }
  return value
}

// For tests.
export function clearAutoCacheVersionMemo(): void {
  cache.clear()
  selfVersion = undefined
}
