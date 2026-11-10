import type { Plugin } from 'rolldown'
import type { DtsCache, VueSfcPluginOptions } from '../src/rolldown'

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'tsdown'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'vue/compiler-sfc'

import { createFileSystemDtsCache, emptyEntry, vueSfcPlugin } from '../src/rolldown'

async function callResolveId(plugin: Required<Pick<Plugin, 'resolveId'>>, id: string, importer: string) {
  return (plugin.resolveId as (this: any, id: string, importer: string, options: any) => unknown).call(
    {},
    id,
    importer,
    { isEntry: false },
  )
}

const root = fileURLToPath(new URL('../node_modules/.tmp/rolldown-build', import.meta.url))

const FIXTURE = `<script setup lang="ts">defineProps<{ msg: string }>()
</script>
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

    const runtime = await readFile(join(root, 'dist-default/Hello.vue'), 'utf8')
    expect(runtime).not.toContain('lang="ts"')
    expect(runtime).not.toContain('defineProps<{ msg: string }>()')
    expect(runtime).toContain('defineProps({ msg:')

    const dts = await readFile(join(root, 'dist-default/Hello.d.vue.ts'), 'utf8')
    expect(dts).toContain('msg')
    expect(dts).toContain('DefineComponent')
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

  it('rewrites `.vue` specifiers from declaration-file importers to `.vue.js` when `emitLegacyDeclarationAlias` is set', async () => {
    const plugin = vueSfcPlugin({ srcDir: 'src', cwd: root, emitLegacyDeclarationAlias: true }) as Required<Pick<Plugin, 'resolveId'>>
    const resolved = await callResolveId(plugin, './Hello.vue', join(root, 'src/index.d.ts'))
    expect(resolved).toEqual({ id: './Hello.vue.js', external: 'relative' })
  })

  it('leaves `.vue` specifiers from declaration-file importers bare when `emitLegacyDeclarationAlias` is off', async () => {
    const plugin = vueSfcPlugin({ srcDir: 'src', cwd: root }) as Required<Pick<Plugin, 'resolveId'>>
    const resolved = await callResolveId(plugin, './Hello.vue', join(root, 'src/index.d.ts'))
    expect(resolved).toEqual({ id: './Hello.vue', external: true })
  })

  it('leaves `.vue` specifiers from non-declaration-file importers bare even when `emitLegacyDeclarationAlias` is set', async () => {
    const plugin = vueSfcPlugin({ srcDir: 'src', cwd: root, emitLegacyDeclarationAlias: true }) as Required<Pick<Plugin, 'resolveId'>>
    const resolved = await callResolveId(plugin, './Hello.vue', join(root, 'src/index.ts'))
    expect(resolved).toEqual({ id: './Hello.vue', external: true })
  })

  it('rewrites `.vue` specifiers from `.d.mts` / `.d.cts` importers too', async () => {
    const plugin = vueSfcPlugin({ srcDir: 'src', cwd: root, emitLegacyDeclarationAlias: true }) as Required<Pick<Plugin, 'resolveId'>>
    expect(await callResolveId(plugin, './Hello.vue', join(root, 'src/index.d.mts'))).toEqual({ id: './Hello.vue.js', external: 'relative' })
    expect(await callResolveId(plugin, './Hello.vue', join(root, 'src/index.d.cts'))).toEqual({ id: './Hello.vue.js', external: 'relative' })
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
  it('fails the build instead of emitting a broken SFC when Vue parsing fails', async () => {
    const badRoot = join(root, 'parse-error')
    await rm(badRoot, { force: true, recursive: true })
    await mkdir(join(badRoot, 'src'), { recursive: true })
    await writeFile(join(badRoot, 'src/index.ts'), 'export const x = 1\n')
    await writeFile(join(badRoot, 'src/Broken.vue'), '<template><div></template>\n')

    await expect(build({
      cwd: badRoot,
      entry: ['src/index.ts'],
      outDir: 'dist',
      logLevel: 'silent',
      plugins: [vueSfcPlugin({ srcDir: 'src', cwd: badRoot, cache: false })],
    })).rejects.toThrow(/vue-sfc-transformer|parse|Invalid end tag/i)
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

  it('resolves self-references through `paths`', async () => {
    const selfRoot = join(root, 'self-reference')
    await rm(selfRoot, { force: true, recursive: true })
    await mkdir(join(selfRoot, 'src/runtime'), { recursive: true })
    await writeFile(join(selfRoot, 'package.json'), JSON.stringify({
      name: 'my-module',
      type: 'module',
      exports: { '.': './dist/module.mjs', './runtime/*': './dist/runtime/*' },
    }))
    await writeFile(join(selfRoot, 'tsconfig.json'), JSON.stringify({ include: ['src'] }))
    await writeFile(join(selfRoot, 'src/module.ts'), `export interface ModuleOptions { size: 'sm' | 'lg' }\n`)
    await writeFile(join(selfRoot, 'src/runtime/index.ts'), 'export const x = 1\n')
    await writeFile(join(selfRoot, 'src/runtime/Sized.vue'), [
      '<script setup lang="ts">',
      `import type { ModuleOptions } from 'my-module'`,
      `defineProps<{ size: ModuleOptions['size'] }>()`,
      '</script>',
      '<template><div /></template>',
    ].join('\n'))

    const options: VueSfcPluginOptions = { srcDir: 'src/runtime', cwd: selfRoot, tsconfig: 'tsconfig.json', cache: false }
    const buildWith = (pluginOptions: VueSfcPluginOptions) => build({
      cwd: selfRoot,
      entry: ['src/runtime/index.ts'],
      outDir: 'dist',
      logLevel: 'silent',
      plugins: [vueSfcPlugin(pluginOptions)],
    })

    await expect(buildWith(options)).rejects.toThrow(`Cannot find module 'my-module'`)
    await buildWith({ ...options, paths: { 'my-module': ['./src/module.ts'] } })

    const dts = await readFile(join(selfRoot, 'dist/Sized.d.vue.ts'), 'utf8')
    expect(dts).toContain(`from 'my-module'`)
    expect(dts).toContain('ModuleOptions')
  })

  it('preserves imports that are referenced only in the template', async () => {
    const templateOnlyRoot = join(root, 'template-only-import')
    await rm(templateOnlyRoot, { force: true, recursive: true })
    await mkdir(join(templateOnlyRoot, 'src'), { recursive: true })
    await writeFile(join(templateOnlyRoot, 'src/index.ts'), 'export const x = 1\n')
    await writeFile(join(templateOnlyRoot, 'src/Child.vue'), '<template><span>child</span></template>\n')
    await writeFile(join(templateOnlyRoot, 'src/types.ts'), 'export interface ChildProps { label: string }\n')
    await writeFile(join(templateOnlyRoot, 'src/Parent.vue'), [
      '<script setup lang="ts">',
      `import Child from './Child.vue'`,
      `import type { ChildProps } from './types'`,
      'defineProps<ChildProps>()',
      '</script>',
      '<template><Child /></template>',
    ].join('\n'))

    await build({
      cwd: templateOnlyRoot,
      entry: ['src/index.ts'],
      outDir: 'dist',
      logLevel: 'silent',
      plugins: [vueSfcPlugin({ srcDir: 'src', cwd: templateOnlyRoot, cache: false })],
    })

    const output = await readFile(join(templateOnlyRoot, 'dist/Parent.vue'), 'utf8')
    const { descriptor } = parse(output, { filename: 'Parent.vue' })
    expect(descriptor.scriptSetup?.content).toContain('import Child from "./Child.vue"')
    expect(descriptor.scriptSetup?.content).not.toContain('./types')
  })

  it('does not emit a synthesized `export {}` when every import is type-only', async () => {
    const typeOnlyRoot = join(root, 'type-only-import')
    await rm(typeOnlyRoot, { force: true, recursive: true })
    await mkdir(join(typeOnlyRoot, 'src'), { recursive: true })
    await writeFile(join(typeOnlyRoot, 'src/index.ts'), 'export const x = 1\n')
    await writeFile(join(typeOnlyRoot, 'src/TypeOnly.vue'), [
      '<script setup lang="ts">',
      `import type { CSSProperties } from 'vue'`,
      `const style: CSSProperties = { color: 'red' }`,
      '</script>',
      '<template><div :style="style">styled</div></template>',
    ].join('\n'))
    await writeFile(join(typeOnlyRoot, 'src/TypeOnlyTrailingComment.vue'), [
      '<script setup lang="ts">',
      `import type { CSSProperties } from 'vue'`,
      `const style: CSSProperties = { color: 'red' }`,
      '// trailing comment',
      '</script>',
      '<template><div :style="style">styled</div></template>',
    ].join('\n'))
    await writeFile(join(typeOnlyRoot, 'src/TypeOnlyScript.vue'), [
      '<script lang="ts">',
      `import type { CSSProperties } from 'vue'`,
      `const style: CSSProperties = { color: 'red' }`,
      '</script>',
      '<script setup lang="ts">',
      `const bound: CSSProperties = style`,
      '</script>',
      '<template><div :style="bound">styled</div></template>',
    ].join('\n'))

    await build({
      cwd: typeOnlyRoot,
      entry: ['src/index.ts'],
      outDir: 'dist',
      logLevel: 'silent',
      plugins: [vueSfcPlugin({ srcDir: 'src', cwd: typeOnlyRoot, cache: false })],
    })

    const output = await readFile(join(typeOnlyRoot, 'dist/TypeOnly.vue'), 'utf8')
    const { descriptor } = parse(output, { filename: 'TypeOnly.vue' })
    expect(descriptor.scriptSetup?.content).not.toContain('export {}')
    expect(descriptor.scriptSetup?.content).toContain('const style = { color: "red" }')

    const withComment = await readFile(join(typeOnlyRoot, 'dist/TypeOnlyTrailingComment.vue'), 'utf8')
    const commented = parse(withComment, { filename: 'TypeOnlyTrailingComment.vue' }).descriptor
    expect(commented.scriptSetup?.content).not.toContain('export {}')
    expect(commented.scriptSetup?.content).toContain('// trailing comment')

    const scriptOutput = await readFile(join(typeOnlyRoot, 'dist/TypeOnlyScript.vue'), 'utf8')
    const script = parse(scriptOutput, { filename: 'TypeOnlyScript.vue' }).descriptor
    expect(script.script?.content).not.toContain('export {}')
    expect(script.script?.content).toContain('const style = { color: "red" }')
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

  describe('emptyEntry', () => {
    const sfcOnlyRoot = join(root, 'sfc-only')

    beforeAll(async () => {
      await rm(sfcOnlyRoot, { force: true, recursive: true })
      await mkdir(join(sfcOnlyRoot, 'src/runtime/components'), { recursive: true })
      await writeFile(join(sfcOnlyRoot, 'src/runtime/components/Hello.vue'), FIXTURE)
    })

    it('builds a source tree that only contains `.vue` files', async () => {
      await build({
        cwd: sfcOnlyRoot,
        entry: emptyEntry,
        root: 'src/runtime',
        unbundle: true,
        dts: true,
        fixedExtension: true,
        outDir: 'dist',
        logLevel: 'silent',
        plugins: [vueSfcPlugin({ srcDir: 'src/runtime', cwd: sfcOnlyRoot, cache: false })],
      })

      const files = await readdir(join(sfcOnlyRoot, 'dist'), { recursive: true })
      expect(files.sort()).toEqual([
        'components',
        'components/Hello.d.vue.ts',
        'components/Hello.vue',
      ])
      const dts = await readFile(join(sfcOnlyRoot, 'dist/components/Hello.d.vue.ts'), 'utf8')
      expect(dts).toContain('msg: string')
    })

    it('can be added alongside script entries', async () => {
      await writeFile(join(sfcOnlyRoot, 'src/runtime/index.ts'), 'export const x: number = 1\n')
      await build({
        cwd: sfcOnlyRoot,
        entry: ['src/runtime/**/*.ts', emptyEntry],
        root: 'src/runtime',
        unbundle: true,
        dts: true,
        fixedExtension: true,
        outDir: 'dist-mixed',
        logLevel: 'silent',
        plugins: [vueSfcPlugin({ srcDir: 'src/runtime', cwd: sfcOnlyRoot, cache: false })],
      })

      const files = await readdir(join(sfcOnlyRoot, 'dist-mixed'), { recursive: true })
      expect(files.filter(f => f.includes('empty-entry'))).toEqual([])
      expect(files).toContain('index.mjs')
      expect(files).toContain('components/Hello.vue')
      expect(files).toContain('components/Hello.d.vue.ts')
    })
  })

  describe('jsx / tsx', () => {
    it('preserves JSX and its script language', async () => {
      const output = await fixture('<script setup lang="jsx">const vnode = <div>hi</div></script>')
      const { scriptSetup } = parse(output).descriptor

      expect(scriptSetup?.lang).toBe('jsx')
      expect(scriptSetup?.content).toContain('<div>hi</div>')
    })

    it('converts TSX macros and types while preserving JSX', async () => {
      const output = await fixture(`<script setup lang="tsx">
  const props = defineProps<{ msg: string }>()
  const emit = defineEmits<{ change: [value: number] }>()
  const vnode = <div>{props.msg as string}</div>
  </script>`)
      const { scriptSetup } = parse(output).descriptor

      expect(scriptSetup?.content).toContain('type: String')
      expect(scriptSetup?.content).toContain('defineEmits(["change"])')
      expect(scriptSetup?.content).toContain('<div>{props.msg}</div>')
      expect(scriptSetup?.content).not.toMatch(/define(?:Props|Emits)</)
      expect(scriptSetup?.content).not.toContain('as string')
      expect(scriptSetup?.lang).toBe('jsx')
    })

    it('converts TSX macros even without JSX syntax', async () => {
      const output = await fixture('<script setup lang="tsx">defineProps<{ msg: string }>()\n</script>')
      const { scriptSetup } = parse(output).descriptor

      expect(scriptSetup?.content).toContain('type: String')
      expect(scriptSetup?.content).not.toContain('defineProps()')
      expect(scriptSetup?.content).not.toContain('defineProps<')
      expect(scriptSetup?.lang).toBe('jsx')
    })

    it('removes template type syntax in a TSX SFC', async () => {
      const output = await fixture(`<script setup lang="tsx">const msg = 'hi'</script>
  <template><div>{{ (msg as string).length }}</div></template>`)
      const { template } = parse(output).descriptor

      expect(template?.content).toContain('msg')
      expect(template?.content).toContain('.length')
      expect(template?.content).not.toContain('as string')
    })

    async function fixture(source: string): Promise<string> {
      const jsxRoot = join(root, 'jsx-tsx')
      await rm(jsxRoot, { force: true, recursive: true })
      await mkdir(join(jsxRoot, 'src'), { recursive: true })
      await writeFile(join(jsxRoot, 'src/index.ts'), 'export const x = 1\n')
      await writeFile(join(jsxRoot, 'src/Component.vue'), source)
      // Declaration emission must respect the project's Vue JSX options.
      await writeFile(join(jsxRoot, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { jsx: 'preserve', jsxImportSource: 'vue' },
      }))

      await build({
        cwd: jsxRoot,
        entry: ['src/index.ts'],
        outDir: 'dist',
        logLevel: 'silent',
        plugins: [vueSfcPlugin({ srcDir: 'src', cwd: jsxRoot, tsconfig: 'tsconfig.json', cache: false })],
      })

      const dts = await readFile(join(jsxRoot, 'dist/Component.d.vue.ts'), 'utf8')
      expect(dts).toContain('DefineComponent')
      if (source.includes('defineProps<')) {
        expect(dts).toContain('msg: string')
      }
      return await readFile(join(jsxRoot, 'dist/Component.vue'), 'utf8')
    }
  })
})
