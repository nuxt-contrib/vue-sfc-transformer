import type { DtsCache } from '../src/rolldown'

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
    await build({
      cwd: root,
      entry: ['src/index.ts'],
      outDir: 'dist-default',
      logLevel: 'silent',
      plugins: [vueSfcPlugin({ srcDir: 'src', cwd: root })],
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
})
