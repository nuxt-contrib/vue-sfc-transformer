export type KnownSFCLang = 'ts' | 'tsx' | 'jsx' | 'js'

// Empty `<script lang="ts">` / `<script lang="tsx" />` blocks are dropped by
// vue/compiler-sfc when `ignoreEmpty` is on, but their `lang` still applies to
// the code generated from the template. Mirrors `emptyScriptLangRE` from
// @vitejs/plugin-vue.
const emptyScriptLangRE = /<script[^>]*\slang\s*=\s*["']?([jt]sx?)\b[^>]*?(?:\/>|>\s*<\/script\s*>)/

/**
 * The script `lang` that applies to the SFC as a whole: the first known
 * `<script>` / `<script setup>` `lang` wins — including empty blocks the SFC
 * parser drops — `'js'` when none matches. Mirrors the `isTS` check in
 * `@vue/compiler-sfc`.
 */
export function getSfcScriptLang(
  raw: string,
  ...blocks: Array<{ lang?: string } | null | undefined>
): KnownSFCLang {
  for (const block of blocks) {
    if (isKnownLang(block?.lang)) {
      return block.lang
    }
  }

  const emptyScriptLang = emptyScriptLangRE.exec(raw)?.[1]
  return isKnownLang(emptyScriptLang) ? emptyScriptLang : 'js'
}

function isKnownLang(lang?: string): lang is KnownSFCLang {
  return lang === 'ts' || lang === 'tsx' || lang === 'jsx' || lang === 'js'
}
