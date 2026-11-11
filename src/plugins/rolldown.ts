import type { Plugin } from 'rolldown'
import type { DtsCache } from '../dts/cache'
import type { Transform } from '../transform'

import { readFile } from 'node:fs/promises'
import process from 'node:process'

import { glob } from 'tinyglobby'

import { formatDeclarationDiagnostic, isDeclarationEmitDiagnostic } from '../dts/diagnostics'
import { emitVueDeclarations } from '../dts/emit'
import { transformVueSfc } from '../transform'
import { isAbsolute, relative, resolve } from '../utils/path'

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
  // `transform` from `rolldown/utils`, used to strip TypeScript from script
  // blocks and template expressions. Pass the one from the rolldown running
  // the build so that only one copy of rolldown is loaded. Defaults to the
  // `rolldown` peer dependency, imported on first use.
  transform?: Transform
  // Which errors in the emitted SFCs fail the build: any (`'all'`, the
  // default), or only those that make declarations missing or wrong, such as
  // syntax errors, TS2742 and skipped emit (`'emit'`), with other errors
  // reported as warnings.
  declarationDiagnostics?: 'all' | 'emit'
}

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
  const preserveSideEffectImports = pluginOptions.preserveSideEffectImports ?? []

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

      const rawSources = new Map<string, string>()
      const runtimeByFile = new Map<string, string>()

      await Promise.all(files.map(async (file) => {
        const raw = await readFile(file, 'utf8')
        rawSources.set(file, raw)
        const { code } = await transformVueSfc(raw, file, { transform: pluginOptions.transform })
        runtimeByFile.set(file, code)
        this.addWatchFile(file)
      }))

      const { files: declarations, diagnostics } = await emitVueDeclarations(
        files.map(id => ({ id, source: rawSources.get(id)! })),
        {
          cwd,
          tsconfig: pluginOptions.tsconfig,
          paths: pluginOptions.paths,
          cache: pluginOptions.cache,
          cacheVersion: pluginOptions.cacheVersion,
          emitLegacyDeclarationAlias: pluginOptions.emitLegacyDeclarationAlias,
        },
      )

      const errors = diagnostics.filter(diagnostic => diagnostic.category === 'error')
      const fatal = pluginOptions.declarationDiagnostics === 'emit' ? errors.filter(isDeclarationEmitDiagnostic) : errors
      if (fatal.length) {
        this.error(`[vue-sfc-transformer] failed to emit Vue declarations:\n${
          fatal.map(diagnostic => formatDeclarationDiagnostic(diagnostic, cwd)).join('\n')}`)
      }
      for (const diagnostic of errors) {
        this.warn(`[vue-sfc-transformer] ${formatDeclarationDiagnostic(diagnostic, cwd)}`)
      }

      for (const file of files) {
        if (!declarations.has(file.replace(/\.vue$/, '.d.vue.ts'))) {
          this.error({ message: `[vue-sfc-transformer] vue-tsc did not emit a declaration for ${file}`, id: file })
        }
        this.emitFile({ type: 'asset', fileName: relative(srcDir, file), source: runtimeByFile.get(file)! })
      }
      for (const [fileName, source] of declarations) {
        this.emitFile({ type: 'asset', fileName: relative(srcDir, fileName), source })
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
