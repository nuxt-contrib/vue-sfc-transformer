import type { Plugin } from 'rolldown'
import type { DtsCache } from '../dts/cache'

import { readFile } from 'node:fs/promises'
import process from 'node:process'

import { isAbsolute, relative, resolve } from 'pathe'
import { transform } from 'rolldown/utils'
import { glob } from 'tinyglobby'
import { preTranspileScriptSetup, transpileVueTemplate } from 'vue-sfc-transformer'
import { parse } from 'vue/compiler-sfc'

import { emitVueDeclarations } from '../dts/emit'
import { escapeSfcAttrValue } from '../utils/attrs'

export interface VueSfcPluginOptions {
  // Source directory containing `.vue` files, relative to `cwd`. Also used
  // as the root that emitted `.vue` / `.d.vue.ts` paths are relative to.
  srcDir: string
  cwd?: string
  // Content-hash cache for emitted declarations. Defaults to a disk cache
  // under `<cwd>/node_modules/.cache/vue-sfc-dts/`; pass a custom `DtsCache`
  // for in-memory / Redis / etc., or `false` to disable caching entirely.
  cache?: DtsCache | false
  // Extra string mixed into the cache key. The cache already invalidates on
  // version changes to this package, `@vue/language-core`, `@volar/typescript`,
  // `typescript`, and the resolved `vueCompilerOptions`; pass this only when
  // you want an additional namespace under your own control.
  cacheVersion?: string
  // Path to a tsconfig.json. Its `vueCompilerOptions` (including any
  // `extends` chain) are passed to `@vue/language-core` for both emission
  // and cache-key derivation. Throws if the file is missing or unparseable.
  tsconfig?: string
  // Imports matching any of these RegExps are kept as external relative .js
  // imports (with their `.ts` extension swapped for `.js`) rather than being
  // bundled. Useful for type-augmentation side-effect modules that look
  // empty to rolldown and would otherwise be tree-shaken out.
  preserveSideEffectImports?: RegExp[]
  // Also emit `<name>.vue.d.ts` alongside `<name>.d.vue.ts`. `vue-tsc` /
  // `@vue/language-core` / `@volar/typescript` resolve `.d.vue.ts` for
  // `import './Foo.vue'`; the `.vue.d.ts` form is only picked up by plain
  // `tsc` with `allowJs` (treating `Foo.vue` as `Foo.vue.js`). Off by
  // default; turn on for compatibility with consumers that resolve via the
  // legacy `.vue.d.ts` convention.
  emitLegacyDeclarationAlias?: boolean
}

async function transpileScript(code: string, filename = '__sfc.ts'): Promise<string> {
  const result = await transform(filename, code, { lang: 'ts', sourcemap: false })
  if (result.errors.length) {
    throw new AggregateError(result.errors, `[vue-sfc-transformer] failed to transpile script in ${filename}`)
  }
  return result.code ?? code
}

// Transform `.vue` files: strip TS from <script>/<script setup> (lowering
// type-only macros via `preTranspileScriptSetup`), strip TS from template expressions,
// then emit:
//
//   foo.vue        runtime SFC with JS-only <script> and template
//   foo.d.vue.ts   typed declaration produced by vue-tsc; the form
//                  `vue-tsc` / `@vue/language-core` / `@volar/typescript`
//                  resolve when an SFC imports `./foo.vue`
//   foo.vue.d.ts   legacy alias, emitted only when
//                  `emitLegacyDeclarationAlias` is set; resolved by plain
//                  `tsc` (treating `foo.vue` as `foo.vue.js`) but not by
//                  vue-tsc / Volar.
//
// `.vue` files are intentionally not added to the bundler's `entry`;
// rolldown would otherwise try to bundle them into `.js`. They're discovered
// in `buildStart` and emitted as assets.
export function vueSfcPlugin(pluginOptions: VueSfcPluginOptions): Plugin {
  const cwd = pluginOptions.cwd ?? process.cwd()
  const srcDir = resolve(cwd, pluginOptions.srcDir)
  const tsconfig = pluginOptions.tsconfig ? resolve(cwd, pluginOptions.tsconfig) : undefined
  const preserveSideEffectImports = pluginOptions.preserveSideEffectImports ?? []

  return {
    name: 'vue-sfc-transformer:vue-sfc',
    async resolveId(id, importer, resolveOptions) {
      if (/\.vue(?:\?|$)/.test(id)) {
        return { id, external: true }
      }
      // Type-augmentation side-effect imports: source files that only contain
      // `declare global` blocks look side-effect-free to rolldown and get
      // tree-shaken out of the built JS. Marking the resolved module as
      // having side effects isn't enough (rolldown drops empty modules), so
      // we externalise it and rely on the sibling unbundle entry to emit it
      // at the matching path.
      if (importer && !resolveOptions.isEntry && preserveSideEffectImports.some(re => re.test(id))) {
        const idWithExt = `${id.replace(/\.[cm]?[tj]sx?$/, '')}.js`
        return { id: idWithExt, external: 'relative' }
      }
      if (!importer || resolveOptions.isEntry) {
        return null
      }
      // Mirror mkdist's per-entry isolation: anything that resolves outside
      // the entry's source directory is left as an external relative import.
      const resolved = await this.resolve(id, importer, { ...resolveOptions, skipSelf: true })
      if (!resolved || resolved.external) {
        return resolved
      }
      if (!isAbsolute(resolved.id)) {
        return resolved
      }
      if (!resolved.id.startsWith(`${srcDir}/`) && resolved.id !== srcDir) {
        return { id, external: 'relative' }
      }
      return resolved
    },
    async buildStart() {
      const files = await glob('**/*.vue', { cwd: srcDir, absolute: true })
      if (files.length === 0) {
        return
      }

      const rawSources = new Map<string, string>()
      const runtimeByFile = new Map<string, string>()

      await Promise.all(files.map(async (file) => {
        const raw = await readFile(file, 'utf8')
        rawSources.set(file, raw)
        const { runtime, errors } = await transformVueSfc(raw, file)
        for (const error of errors) {
          this.error({ message: `[vue-sfc-transformer] ${file}: ${error.message}`, id: file })
        }
        runtimeByFile.set(file, runtime)
        this.addWatchFile(file)
      }))

      const declarations = await emitVueDeclarations(
        files.map(id => ({ id, source: rawSources.get(id)! })),
        {
          rootDir: cwd,
          tsconfig,
          cache: pluginOptions.cache,
          cacheVersion: pluginOptions.cacheVersion,
        },
      )

      for (const file of files) {
        const rel = relative(srcDir, file)
        this.emitFile({ type: 'asset', fileName: rel, source: runtimeByFile.get(file)! })
        const dts = declarations.get(file)
        if (dts === undefined) {
          this.error({ message: `[vue-sfc-transformer] vue-tsc did not emit a declaration for ${file}`, id: file })
        }
        this.emitFile({ type: 'asset', fileName: rel.replace(/\.vue$/, '.d.vue.ts'), source: dts })
        if (pluginOptions.emitLegacyDeclarationAlias) {
          this.emitFile({ type: 'asset', fileName: `${rel}.d.ts`, source: dts })
        }
      }
    },
  }
}

interface TransformResult {
  runtime: string
  errors: Error[]
}

async function transformVueSfc(input: string, filename: string): Promise<TransformResult> {
  const errors: Error[] = []
  const sfc = parse(input, { filename, ignoreEmpty: true })
  if (sfc.errors.length) {
    for (const error of sfc.errors) {
      errors.push(error instanceof Error ? error : new Error(String(error)))
    }
    return { runtime: input, errors }
  }

  const isTs = [sfc.descriptor.script, sfc.descriptor.scriptSetup].some(b => b?.lang === 'ts')

  const blocks: Array<{ type: string, attrs: Record<string, string | true>, content: string, offset: number }> = []

  if (sfc.descriptor.scriptSetup) {
    const block = isTs
      ? await preTranspileScriptSetup(sfc.descriptor, filename)
      : sfc.descriptor.scriptSetup
    const content = isTs ? await transpileScript(block.content) : block.content
    blocks.push({
      type: 'script',
      attrs: stripAttrs(block.attrs, ['lang', 'generic']),
      content,
      offset: sfc.descriptor.scriptSetup.loc.start.offset,
    })
  }
  if (sfc.descriptor.script) {
    const block = sfc.descriptor.script
    const content = block.lang === 'ts' ? await transpileScript(block.content) : block.content
    blocks.push({
      type: 'script',
      attrs: stripAttrs(block.attrs, ['lang']),
      content,
      offset: block.loc.start.offset,
    })
  }
  if (sfc.descriptor.template) {
    const block = sfc.descriptor.template
    const content = isTs && block.ast
      ? await transpileVueTemplate(block.content, block.ast, block.loc.start.offset, async code => transpileScript(code))
      : block.content
    blocks.push({
      type: 'template',
      attrs: block.attrs,
      content,
      offset: block.loc.start.offset,
    })
  }
  for (const style of sfc.descriptor.styles) {
    blocks.push({
      type: 'style',
      attrs: style.attrs,
      content: style.content,
      offset: style.loc.start.offset,
    })
  }
  for (const custom of sfc.descriptor.customBlocks) {
    blocks.push({
      type: custom.type,
      attrs: custom.attrs,
      content: custom.content,
      offset: custom.loc.start.offset,
    })
  }

  blocks.sort((a, b) => a.offset - b.offset)

  const runtime = blocks.map((block) => {
    const attrs = Object.entries(block.attrs)
      .map(([key, value]) => value === true ? key : value ? `${key}="${escapeSfcAttrValue(value)}"` : undefined)
      .filter(Boolean)
      .join(' ')
    const header = `<${`${block.type} ${attrs}`.trim()}>`
    const footer = `</${block.type}>`
    const body = block.content.replace(/(\n\n)\n+/g, '\n\n').replace(/^\s*\n|\n\s*$/g, '')
    return `${header}\n${body}\n${footer}\n`
  }).join('\n')

  return { runtime, errors }
}

function stripAttrs(attrs: Record<string, string | true>, remove: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {}
  for (const [key, value] of Object.entries(attrs)) {
    if (!remove.includes(key)) {
      out[key] = value
    }
  }
  return out
}
