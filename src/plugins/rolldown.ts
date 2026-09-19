import type { Plugin } from 'rolldown'
import type { transform as rolldownTransform } from 'rolldown/utils'
import type { DtsCache } from '../dts/cache'

import { readFile } from 'node:fs/promises'
import process from 'node:process'

import { glob } from 'tinyglobby'
import { preTranspileScriptSetup, transpileVueTemplate } from 'vue-sfc-transformer'
import { parse } from 'vue/compiler-sfc'

import { emitVueDeclarations } from '../dts/emit'
import { escapeSfcAttrValue } from '../utils/attrs'
import { isAbsolute, relative, resolve } from '../utils/path'
import { getSfcScriptLang } from '../utils/script-lang'
import { transpileScriptBlock } from '../utils/script-transpile'

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
  // `typescript`, and the resolved compiler options and `vueCompilerOptions`;
  // pass this only when you want an additional namespace under your own
  // control.
  cacheVersion?: string
  // Path to a tsconfig.json. Declarations are emitted from the project it
  // describes: its compiler options, `vueCompilerOptions` and files (including
  // any `extends` chain), or the projects it references when it has no files
  // of its own. Only errors in the emitted SFCs fail the build. Throws if the
  // file is missing or unparseable.
  tsconfig?: string
  // Extra `compilerOptions.paths` for declaration emit, with targets relative
  // to `cwd`, taking precedence over the tsconfig's. Use it to resolve the
  // package's own name to its sources, e.g.
  // `{ 'my-module': ['./src/module.ts'], 'my-module/*': ['./src/*'] }`.
  paths?: Record<string, string[]>
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
  //
  // Also changes how `.vue` imports from *other emitted declaration files*
  // are rewritten: with this on, `import './Foo.vue'` in an emitted `.d.ts`
  // becomes `import './Foo.vue.js'`, pointing dts bundlers (and plain
  // `tsc`) at the `Foo.vue.d.ts` alias instead of a bare `.vue` specifier
  // that resolves to the runtime SFC.
  emitLegacyDeclarationAlias?: boolean
  // Overrides the petrea-based TypeScript stripping of script blocks with
  // `transform` from `rolldown/utils`. Pass the one from the rolldown running
  // the build so that only one copy of rolldown is loaded.
  transform?: Transform
}

type Transform = typeof rolldownTransform

const EMPTY_ENTRY_ID = '\0vue-sfc-transformer:empty-entry'

/**
 * An entry for builds whose source tree may contain no script files, only
 * `.vue` files. Pass it as tsdown's `entry` (or rolldown's `input`), or add it
 * alongside other entries. `vueSfcPlugin` resolves it to an empty module and
 * removes its chunk from the output.
 */
export const emptyEntry: Record<string, string> = {
  'vue-sfc-transformer-empty-entry': EMPTY_ENTRY_ID,
}

async function transpileScript(transform: Transform, code: string, lang: 'ts' | 'tsx' = 'ts', filename = `__sfc.${lang}`): Promise<string> {
  const result = await transform(filename, code, {
    lang,
    sourcemap: false,
    // Only TypeScript is stripped; JSX stays in the output and is lowered by
    // the consumer's toolchain.
    ...(lang === 'tsx' ? { jsx: 'preserve' as const } : {}),
    // Usage-based elision would drop imports referenced only in the template,
    // which this transform never sees.
    typescript: { onlyRemoveTypeImports: true },
  })
  if (result.errors.length) {
    throw new AggregateError(result.errors, `[vue-sfc-transformer] failed to transpile script in ${filename}`)
  }
  // oxc appends `export {}` when every import is elided as type-only; it is
  // invalid in `<script setup>`, and is emitted before any trailing trivia.
  return (result.code ?? code).replace(/^export \{\};?[ \t]*\r?\n?/m, '')
}

async function transpileScriptWithOptions(transform: Transform | undefined, code: string, lang: 'ts' | 'tsx', filename: string): Promise<string> {
  return transform ? transpileScript(transform, code, lang, filename) : transpileScriptBlock(code, lang, filename)
}

// A `tsx` script still contains JSX after TypeScript is stripped, so its lang
// attribute is rewritten to `jsx` rather than dropped, telling the consumer's
// toolchain to lower the JSX. Scripts without TypeScript keep their lang.
function scriptAttrs(
  attrs: Record<string, string | true>,
  lang: string | undefined,
  transpiled: boolean,
): Record<string, string | true> {
  const stripped = stripAttrs(attrs, ['lang', 'generic'])
  if (lang === 'tsx') {
    return { ...stripped, lang: 'jsx' }
  }
  if (!transpiled && lang) {
    return { ...stripped, lang }
  }
  return stripped
}

// Transform `.vue` files: strip TS from <script>/<script setup> (lowering
// type-only macros via `preTranspileScriptSetup`), strip TS from template
// expressions, then emit:
//
//   foo.vue        runtime SFC with JS-only <script> and template. A `tsx`
//                  script is re-tagged `lang="jsx"`: only its TypeScript is
//                  stripped, the JSX is left for the consumer's toolchain.
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
  const paths = pluginOptions.paths
    ? Object.fromEntries(Object.entries(pluginOptions.paths).map(([key, targets]) => [key, targets.map(target => resolve(cwd, target))]))
    : undefined

  return {
    name: 'vue-sfc-transformer:vue-sfc',
    async resolveId(id, importer, resolveOptions) {
      if (id === EMPTY_ENTRY_ID) {
        return id
      }
      if (/\.vue(?:\?|$)/.test(id)) {
        if (pluginOptions.emitLegacyDeclarationAlias && importer && /\.d\.[cm]?ts$/.test(importer)) {
          return { id: `${id}.js`, external: 'relative' }
        }
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

      const transform = pluginOptions.transform
      const rawSources = new Map<string, string>()
      const runtimeByFile = new Map<string, string>()

      await Promise.all(files.map(async (file) => {
        const raw = await readFile(file, 'utf8')
        rawSources.set(file, raw)
        const { runtime, errors } = await transformVueSfc(raw, file, transform)
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
          paths,
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
    load: {
      filter: { id: /^\0vue-sfc-transformer:empty-entry$/ },
      handler(id) {
        if (id === EMPTY_ENTRY_ID) {
          return { code: 'export {}', moduleSideEffects: false }
        }
      },
    },
    generateBundle(_outputOptions, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type === 'chunk' && output.facadeModuleId === EMPTY_ENTRY_ID) {
          delete bundle[fileName]
        }
      }
    },
  }
}

interface TransformResult {
  runtime: string
  errors: Error[]
}

async function transformVueSfc(input: string, filename: string, transform: Transform | undefined): Promise<TransformResult> {
  const errors: Error[] = []
  const sfc = parse(input, { filename, ignoreEmpty: true })
  if (sfc.errors.length) {
    for (const error of sfc.errors) {
      errors.push(error instanceof Error ? error : new Error(String(error)))
    }
    return { runtime: input, errors }
  }

  const sfcScriptLang = getSfcScriptLang(input, sfc.descriptor.script, sfc.descriptor.scriptSetup)
  const isTs = sfcScriptLang === 'ts' || sfcScriptLang === 'tsx'

  const blocks: Array<{ type: string, attrs: Record<string, string | true>, content: string, offset: number }> = []

  if (sfc.descriptor.scriptSetup) {
    const setup = sfc.descriptor.scriptSetup
    // `setup.lang` decides; `isTs` only applies when the setup block itself is
    // untagged (a sibling `<script lang="ts">` implies TS for it too).
    const setupIsTs = setup.lang === 'ts' || setup.lang === 'tsx' || (!setup.lang && isTs)
    const block = setupIsTs ? await preTranspileScriptSetup(sfc.descriptor, filename) : setup
    const content = setupIsTs
      ? await transpileScriptWithOptions(transform, block.content, setup.lang === 'tsx' ? 'tsx' : 'ts', filename)
      : block.content
    blocks.push({
      type: 'script',
      attrs: scriptAttrs(setup.attrs, setup.lang, setupIsTs),
      content,
      offset: setup.loc.start.offset,
    })
  }
  if (sfc.descriptor.script) {
    const block = sfc.descriptor.script
    const scriptLang = block.lang === 'ts' || block.lang === 'tsx' ? block.lang : undefined
    const content = scriptLang
      ? await transpileScriptWithOptions(transform, block.content, scriptLang, filename)
      : block.content
    blocks.push({
      type: 'script',
      attrs: scriptAttrs(block.attrs, block.lang, scriptLang !== undefined),
      content,
      offset: block.loc.start.offset,
    })
  }
  if (sfc.descriptor.template) {
    const block = sfc.descriptor.template
    const content = isTs && block.ast
      ? await transpileVueTemplate(block.content, block.ast, block.loc.start.offset)
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
