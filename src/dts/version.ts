import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

import * as vueLanguageCore from '@vue/language-core'
import ts from 'typescript'

import { readTsconfigJson } from './tsconfig'

const require = createRequire(import.meta.url)

interface VersionInputs {
  rootDir: string
  // Absolute path to a tsconfig.json whose `vueCompilerOptions` (incl. any
  // `extends` chain) should be mixed into the hash. Omit to hash the default
  // vue options.
  tsconfig?: string
}

const cache = new Map<string, string>()

// Compute a cache-key prefix that captures every input to the emitted .d.ts
// output that lives *outside* the SFC source itself: this package, the Vue
// language plugin, the Volar program proxy, the TypeScript compiler, and the
// resolved `vueCompilerOptions` (including any `extends` chain from the
// consumer's tsconfig).
export function getAutoCacheVersion(inputs: VersionInputs): string {
  const memoKey = `${inputs.rootDir}\0${inputs.tsconfig ?? ''}`
  const cached = cache.get(memoKey)
  if (cached !== undefined) {
    return cached
  }

  const parts: string[] = [
    `vue-sfc-transformer=${readSelfVersion()}`,
    `@vue/language-core=${readDependencyVersion('@vue/language-core')}`,
    `@volar/typescript=${readDependencyVersion('@volar/typescript')}`,
    `typescript=${ts.version}`,
    `vueCompilerOptions=${hashVueCompilerOptions(inputs)}`,
  ]
  const computed = parts.join('|')
  cache.set(memoKey, computed)
  return computed
}

function readDependencyVersion(name: string): string {
  // Resolving `<name>/package.json` works for any package that doesn't
  // explicitly hide it from its `exports` map; `@vue/language-core` and
  // `@volar/typescript` both expose it.
  const pkg = require(`${name}/package.json`) as { version?: string }
  return pkg.version ?? 'unknown'
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

function hashVueCompilerOptions(inputs: VersionInputs): string {
  try {
    const { vueOptions } = vueLanguageCore.createParsedCommandLineByJson(
      ts,
      ts.sys,
      inputs.rootDir,
      readTsconfigJson(inputs.tsconfig),
      inputs.tsconfig,
    )
    return createHash('sha256').update(JSON.stringify(vueOptions, replacer)).digest('hex').slice(0, 16)
  }
  catch {
    // If we can't compute the hash (bad tsconfig path that escaped
    // validation, etc.), don't take the whole build down; fall back to a
    // constant so the rest of the auto-version still does its job.
    return 'unknown'
  }
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
