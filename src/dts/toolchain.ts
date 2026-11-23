import type * as VolarTypeScript from '@volar/typescript'
import type * as VueLanguageCore from '@vue/language-core'
import type TypeScript from 'typescript'

import { createRequire } from 'node:module'

import { resolve } from '../utils/path'

export interface Toolchain {
  ts: typeof TypeScript
  volarTs: typeof VolarTypeScript
  vueLanguageCore: typeof VueLanguageCore
  versions: Record<'@vue/language-core' | '@volar/typescript' | 'typescript', string>
}

const toolchains = new Map<string, Map<typeof TypeScript, Toolchain>>()

// TypeScript, `@volar/typescript` and `@vue/language-core` are loaded from
// the project's `vue-tsc` (v3 or later) when it has one, so declarations are
// checked the way `vue-tsc` checks the project. Otherwise they are this
// package's peer dependencies. A `typescript` module passed to `loadToolchain`
// is used in place of the one resolved from `vue-tsc`.
export function loadToolchain(rootDir: string, typescript?: typeof TypeScript): Toolchain {
  const base = resolveVueTsc(rootDir) ?? import.meta.url
  const require = createRequire(base)
  const ts = typescript ?? (require('typescript') as typeof TypeScript)
  let toolchain = toolchains.get(base)?.get(ts)
  if (!toolchain) {
    if (typeof ts.createProgram !== 'function') {
      const source = typescript ? 'passed in the `typescript` option' : `loaded from ${base}`
      throw new Error(`[vue-sfc-transformer] TypeScript ${readTypeScriptVersion(ts)} ${source} has no JavaScript API. Pass the \`typescript\` option or install TypeScript 5 or 6.`)
    }
    toolchain = {
      ts,
      volarTs: require('@volar/typescript'),
      vueLanguageCore: require('@vue/language-core'),
      versions: {
        '@vue/language-core': readVersion(require, '@vue/language-core'),
        '@volar/typescript': readVersion(require, '@volar/typescript'),
        'typescript': ts.version,
      },
    }
    let byBase = toolchains.get(base)
    if (!byBase) {
      byBase = new Map()
      toolchains.set(base, byBase)
    }
    byBase.set(ts, toolchain)
  }
  return toolchain
}

function readTypeScriptVersion(ts: typeof TypeScript): string {
  return (ts as { version?: string }).version ?? 'unknown'
}

// Before 3.3.6, `@vue/language-core` caches the TypeScript AST of each SFC
// block in a module-level `Map`, so disposing virtual code leaks every block
// created after it (vuejs/language-tools@c82592d).
export function canDisposeVirtualCode({ versions }: Toolchain): boolean {
  const [major = 0, minor = 0, patch = 0] = versions['@vue/language-core'].split(/[.-]/, 3).map(Number)
  return major > 3 || (major === 3 && (minor > 3 || (minor === 3 && patch >= 6)))
}

function resolveVueTsc(rootDir: string): string | undefined {
  try {
    const require = createRequire(resolve(rootDir, 'package.json'))
    const packageJson = require.resolve('vue-tsc/package.json')
    const { version } = require(packageJson) as { version: string }
    return Number.parseInt(version) >= 3 ? packageJson : undefined
  }
  catch {
    return undefined
  }
}

function readVersion(require: NodeJS.Require, name: string): string {
  return (require(`${name}/package.json`) as { version?: string }).version ?? 'unknown'
}
