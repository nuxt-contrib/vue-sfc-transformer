import type { DtsCache, VueSfcPluginOptions } from '../src/rolldown'

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'pathe'
import { build } from 'tsdown'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'vue/compiler-sfc'

import { createFileSystemDtsCache, vueSfcPlugin } from '../src/rolldown'

const root = fileURLToPath(new URL('../node_modules/.tmp/rolldown-build', import.meta.url))

const FIXTURE = `<script setup lang="ts">defineProps<{ msg: string }>()</script>
<template><div>{{ msg }}</div></template>
`

async function setupFixture(): Promise<void> {
  await rm(root, { force: true, recursive: true })
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src/index.ts'), 'export const x = 1\n')
  await writeFile(join(root, 'src/Hello.vue'), FIXTURE)
}

describe('vueSfcPlugin (end-to-end build)', { timeout: 60_000 }, () => {
  beforeAll(setupFixture)
  afterAll(async () => {
    await rm(root, { force: true, recursive: true })
  })

  it('emits `.d.vue.ts` by default and no `.vue.d.ts`', async () => {
    const pluginOptions: VueSfcPluginOptions = { srcDir: 'src', cwd: root }
    await build({
      cwd: root,
      entry: ['src/index.ts'],
      outDir: 'dist-default',
      logLevel: 'silent',
      plugins: [vueSfcPlugin(pluginOptions)],
    })
    const files = await readdir(join(root, 'dist-default'))
    expect(files).toContain('Hello.vue')
    expect(files).toContain('Hello.d.vue.ts')
    expect(files).not.toContain('Hello.vue.d.ts')
  })

  it('also emits the legacy `.vue.d.ts` when `emitLegacyDeclarationAlias` is set', async () => {
    await build({
      cwd: root,
      entry: ['src/index.ts'],
      outDir: 'dist-legacy',
      logLevel: 'silent',
      plugins: [vueSfcPlugin({ srcDir: 'src', cwd: root, emitLegacyDeclarationAlias: true })],
    })
    const files = await readdir(join(root, 'dist-legacy'))
    expect(files).toContain('Hello.vue')
    expect(files).toContain('Hello.d.vue.ts')
    expect(files).toContain('Hello.vue.d.ts')
  })

  it('populates the default fs cache under `<cwd>/node_modules/.cache/vue-sfc-dts/`', async () => {
    const cacheDir = join(root, 'node_modules/.cache/vue-sfc-dts')
    await rm(cacheDir, { force: true, recursive: true })

    await build({
      cwd: root,
      entry: ['src/index.ts'],
      outDir: 'dist-cache',
      logLevel: 'silent',
      plugins: [vueSfcPlugin({ srcDir: 'src', cwd: root })],
    })

    const cached = await readdir(cacheDir)
    expect(cached.some(f => f.endsWith('.d.ts'))).toBe(true)
  })

  it('accepts a custom `DtsCache` implementation', async () => {
    const cacheDir = join(root, 'custom-cache')
    const cache: DtsCache = createFileSystemDtsCache({ dir: cacheDir })
    await build({
      cwd: root,
      entry: ['src/index.ts'],
      outDir: 'dist-custom-cache',
      logLevel: 'silent',
      plugins: [vueSfcPlugin({ srcDir: 'src', cwd: root, cache })],
    })
    const files = await readdir(join(root, 'dist-custom-cache'))
    expect(files).toContain('Hello.d.vue.ts')
    const cached = await readdir(cacheDir)
    expect(cached.some(f => f.endsWith('.d.ts'))).toBe(true)
  })

  it('skips the cache when `cache: false`', async () => {
    const cacheDir = join(root, 'node_modules/.cache/vue-sfc-dts-disabled')
    await build({
      cwd: root,
      entry: ['src/index.ts'],
      outDir: 'dist-no-cache',
      logLevel: 'silent',
      plugins: [vueSfcPlugin({ srcDir: 'src', cwd: root, cache: false })],
    })
    // Sanity: build still produces declarations.
    const files = await readdir(join(root, 'dist-no-cache'))
    expect(files).toContain('Hello.d.vue.ts')
    // The disabled-cache scratch dir wasn't populated by the build (it isn't
    // even passed to the plugin, this just asserts the cache dir we'd have
    // used isn't being secretly written to).
    let cached: string[] = []
    try {
      cached = await readdir(cacheDir)
    }
    catch {}
    expect(cached).toEqual([])
  })
  it('resolves a relative tsconfig path from the plugin cwd', async () => {
    const tsconfigRoot = join(root, 'relative-tsconfig')
    await rm(tsconfigRoot, { force: true, recursive: true })
    await mkdir(join(tsconfigRoot, 'src'), { recursive: true })
    await mkdir(join(tsconfigRoot, 'types'), { recursive: true })
    await writeFile(join(tsconfigRoot, 'src/index.ts'), 'export const x = 1\n')
    await writeFile(join(tsconfigRoot, 'types/button.ts'), 'export interface ButtonProps { label: string }\n')
    await writeFile(join(tsconfigRoot, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        paths: {
          '#button': ['./types/button.ts'],
        },
      },
    }))
    await writeFile(join(tsconfigRoot, 'src/Button.vue'), [
      '<script setup lang="ts">',
      'import type { ButtonProps } from "#button"',
      'defineProps<ButtonProps>()',
      '</script>',
      '<template><button>{{ label }}</button></template>',
    ].join('\n'))

    await build({
      cwd: tsconfigRoot,
      entry: ['src/index.ts'],
      outDir: 'dist',
      logLevel: 'silent',
      plugins: [vueSfcPlugin({ srcDir: 'src', cwd: tsconfigRoot, tsconfig: 'tsconfig.json', cache: false })],
    })

    const dts = await readFile(join(tsconfigRoot, 'dist/Button.d.vue.ts'), 'utf8')
    expect(dts).toContain('ButtonProps')
    expect(dts).toContain('#button')
  })

  // Bug: attribute values are serialised with `key="${value}"` without
  // escaping double quotes in `value`. A single-quoted attribute like
  // `note='says "hi"'` round-trips as `note="says "hi""` - invalid XML,
  // so re-parsing the emitted .vue file recovers a truncated value.
  it('serialises SFC block attribute values containing double-quotes as valid XML', async () => {
    await writeFile(
      join(root, 'src/Quoted.vue'),
      [
        `<template><div>hello</div></template>`,
        `<docs note='says "hello"'>`,
        `some docs`,
        `</docs>`,
      ].join('\n'),
    )
    await writeFile(join(root, 'src/entry.ts'), `export const y = 2\n`)

    await build({
      cwd: root,
      entry: ['src/entry.ts'],
      outDir: 'dist-attr-escape',
      logLevel: 'silent',
      plugins: [vueSfcPlugin({ srcDir: 'src', cwd: root, cache: false })],
    })

    const output = await readFile(join(root, 'dist-attr-escape/Quoted.vue'), 'utf8')
    // Re-parse the emitted file: the `note` attribute value must survive the
    // round-trip intact.
    const { descriptor } = parse(output, { filename: 'Quoted.vue' })
    expect(descriptor.customBlocks[0]?.attrs?.note).toBe('says "hello"')
  })

  it('preserves literal character references in SFC block attribute values', async () => {
    await writeFile(
      join(root, 'src/Ampersand.vue'),
      [
        `<template><div>hello</div></template>`,
        `<docs note="Tom &amp; Jerry &amp;quot;">`,
        `some docs`,
        `</docs>`,
      ].join('\n'),
    )
    await writeFile(join(root, 'src/entry.ts'), `export const y = 2\n`)

    await build({
      cwd: root,
      entry: ['src/entry.ts'],
      outDir: 'dist-attr-ampersand-escape',
      logLevel: 'silent',
      plugins: [vueSfcPlugin({ srcDir: 'src', cwd: root, cache: false })],
    })

    const output = await readFile(join(root, 'dist-attr-ampersand-escape/Ampersand.vue'), 'utf8')
    // Vue's parser decodes character references in attributes, so the emitted
    // `&` must be escaped before `"` to keep a literal `&quot;` from becoming `"`.
    const { descriptor } = parse(output, { filename: 'Ampersand.vue' })
    expect(descriptor.customBlocks[0]?.attrs?.note).toBe('Tom & Jerry &quot;')
  })

  // Bug: `id.replace(/\.[tj]s$/, '')` in preserveSideEffectImports does not
  // match `.mts` (or `.cts`, `.tsx`, …), so `./augment.mts` becomes
  // `./augment.mts.js` instead of `./augment.js`.
  it('preserveSideEffectImports: rewrites .mts imports to .js, not .mts.js', async () => {
    await writeFile(join(root, 'src/index.ts'), `import './augment.mts'\nexport const x = 1\n`)
    await writeFile(join(root, 'src/augment.mts'), `export {}\n`)

    await build({
      cwd: root,
      entry: ['src/index.ts'],
      outDir: 'dist-mts',
      logLevel: 'silent',
      plugins: [vueSfcPlugin({ srcDir: 'src', cwd: root, preserveSideEffectImports: [/augment/] })],
    })

    const output = await readFile(join(root, 'dist-mts/index.mjs'), 'utf8')
    // Should reference `./augment.js` (or a path containing `augment.js`),
    // not `augment.mts.js`.
    expect(output).not.toMatch(/augment\.mts\.js/)
    expect(output).toMatch(/augment\.js/)
  })
})
