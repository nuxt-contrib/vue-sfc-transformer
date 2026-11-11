import type { transform as rolldownTransform } from 'rolldown/utils'
import type { KnownSFCLang } from './utils/script-lang'

import { parse } from 'vue/compiler-sfc'

import { escapeSfcAttrValue } from './utils/attrs'
import { getSfcScriptLang } from './utils/script-lang'
import { preTranspileScriptSetup } from './utils/script-setup'
import { transpileVueTemplate } from './utils/template'

export type Transform = typeof rolldownTransform

export interface TransformVueSfcOptions {
  /**
   * `transform` from `rolldown/utils`, used to strip TypeScript from script
   * blocks and template expressions. Pass the one from the rolldown running
   * the build so that only one copy of rolldown is loaded. Defaults to the
   * `rolldown` peer dependency, imported on first use.
   */
  transform?: Transform
}

export interface TransformVueSfcResult {
  /** The runtime SFC, with TypeScript stripped from its scripts and template. */
  code: string
  /**
   * The script language of the SFC as a whole. TypeScript was stripped when
   * it is `'ts'` or `'tsx'`; a `tsx` script is emitted as `lang="jsx"`.
   */
  lang: KnownSFCLang
}

let defaultTransform: Promise<Transform> | undefined
function loadDefaultTransform(): Promise<Transform> {
  defaultTransform ??= import('rolldown/utils').then(r => r.transform)
  return defaultTransform
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

/**
 * Transform a Vue SFC into its runtime form: strip TypeScript from
 * `<script>` and `<script setup>` (lowering type-only macros such as
 * `defineProps<T>()` to runtime declarations) and from template expressions,
 * and drop the `lang` and `generic` attributes TypeScript requires. Styles and
 * custom blocks are kept as they are.
 *
 * Throws if the SFC cannot be parsed or a script fails to transpile.
 */
export async function transformVueSfc(code: string, id: string, options: TransformVueSfcOptions = {}): Promise<TransformVueSfcResult> {
  const sfc = parse(code, { filename: id, ignoreEmpty: true })
  if (sfc.errors.length) {
    throw new AggregateError(sfc.errors, `[vue-sfc-transformer] ${id}: ${sfc.errors.map(error => error.message).join('\n')}`)
  }

  const transform = options.transform ?? await loadDefaultTransform()
  const lang = getSfcScriptLang(code, sfc.descriptor.script, sfc.descriptor.scriptSetup)
  const isTs = lang === 'ts' || lang === 'tsx'

  const blocks: Array<{ type: string, attrs: Record<string, string | true>, content: string, offset: number }> = []

  if (sfc.descriptor.scriptSetup) {
    const setup = sfc.descriptor.scriptSetup
    // `setup.lang` decides; `isTs` only applies when the setup block itself is
    // untagged (a sibling `<script lang="ts">` implies TS for it too).
    const setupIsTs = setup.lang === 'ts' || setup.lang === 'tsx' || (!setup.lang && isTs)
    const block = setupIsTs ? await preTranspileScriptSetup(sfc.descriptor, id) : setup
    const content = setupIsTs
      ? await transpileScript(transform, block.content, setup.lang === 'tsx' ? 'tsx' : 'ts')
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
      ? await transpileScript(transform, block.content, scriptLang)
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
      ? await transpileVueTemplate(block.content, block.ast, block.loc.start.offset, async code => transpileScript(transform, code))
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

  return { code: runtime, lang }
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
