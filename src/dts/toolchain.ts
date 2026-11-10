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

const toolchains = new Map<string, Toolchain>()

// TypeScript, `@volar/typescript` and `@vue/language-core` are loaded from
// the project's `vue-tsc` (v3 or later) when it has one, so declarations are
// checked the way `vue-tsc` checks the project. Otherwise they are this
// package's peer dependencies.
export function loadToolchain(rootDir: string): Toolchain {
  const base = resolveVueTsc(rootDir) ?? import.meta.url
  let toolchain = toolchains.get(base)
  if (!toolchain) {
    const require = createRequire(base)
    const ts = require('typescript') as typeof TypeScript
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
    toolchains.set(base, toolchain)
  }
  return toolchain
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
