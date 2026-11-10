import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { loadToolchain } from '../src/dts/toolchain'
import { getAutoCacheVersion } from '../src/dts/version'

const dir = fileURLToPath(new URL('../node_modules/.tmp/dts-toolchain', import.meta.url))
const languageCore = createRequire(import.meta.url).resolve('@vue/language-core')

async function fixture(name: string, vueTscVersion: string): Promise<string> {
  const root = join(dir, name)
  await mkdir(join(root, 'node_modules/vue-tsc'), { recursive: true })
  await mkdir(join(root, 'node_modules/@vue/language-core'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name }))
  await writeFile(join(root, 'node_modules/vue-tsc/package.json'), JSON.stringify({ name: 'vue-tsc', version: vueTscVersion }))
  await writeFile(join(root, 'node_modules/@vue/language-core/package.json'), JSON.stringify({ name: '@vue/language-core', version: '3.0.0-project', main: 'index.js' }))
  await writeFile(join(root, 'node_modules/@vue/language-core/index.js'), `module.exports = require(${JSON.stringify(languageCore)})\n`)
  return root
}

describe('loadToolchain', () => {
  beforeAll(async () => {
    await rm(dir, { force: true, recursive: true })
  })
  afterAll(async () => {
    await rm(dir, { force: true, recursive: true })
  })

  it('loads `@vue/language-core` alongside the project\'s `vue-tsc`', async () => {
    const toolchain = loadToolchain(await fixture('vue-tsc-3', '3.9.0'))
    expect(toolchain.versions['@vue/language-core']).toBe('3.0.0-project')
    expect(toolchain.vueLanguageCore.createVueLanguagePlugin).toBeTypeOf('function')
  })

  it('keys the cache by the versions of the project\'s toolchain', async () => {
    const version = getAutoCacheVersion({ rootDir: await fixture('cache-version', '3.9.0') })
    expect(version.split('|')).toContain('@vue/language-core=3.0.0-project')
  })

  it('resolves `vue-tsc` from a relative root', async () => {
    const root = await fixture('relative-root', '3.9.0')
    const toolchain = loadToolchain(relative(process.cwd(), root))
    expect(toolchain.versions['@vue/language-core']).toBe('3.0.0-project')
  })

  it('ignores `vue-tsc` before v3', async () => {
    const toolchain = loadToolchain(await fixture('vue-tsc-2', '2.2.0'))
    expect(toolchain.versions['@vue/language-core']).not.toBe('3.0.0-project')
  })
})
