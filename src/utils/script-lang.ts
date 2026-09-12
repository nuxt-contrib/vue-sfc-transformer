// Empty `<script lang="ts">` blocks are dropped by vue/compiler-sfc when
// `ignoreEmpty` is on, but their `lang` still applies to the code generated
// from the template. Mirrors `emptyScriptLangRE` from @vitejs/plugin-vue.
const emptyScriptTsLangRE = /<script[^>]*\slang\s*=\s*["']?ts\b[^>]*?(?:\/>|>\s*<\/script\s*>)/

/**
 * The script `lang` that applies to the SFC as a whole: `'ts'` when any
 * `<script>` / `<script setup>` block has `lang="ts"` — including empty
 * blocks the SFC parser drops — `undefined` otherwise.
 */
export function getSfcScriptLang(
  raw: string,
  ...blocks: Array<{ lang?: string } | null | undefined>
): 'ts' | undefined {
  for (const block of blocks) {
    if (block?.lang === 'ts') {
      return 'ts'
    }
  }
  return emptyScriptTsLangRE.test(raw) ? 'ts' : undefined
}
