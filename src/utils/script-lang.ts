export type KnownSFCLang = 'ts' | 'tsx' | 'jsx' | 'js'

// Empty `<script lang="ts">` / `<script lang="tsx" />` blocks are dropped by
// vue/compiler-sfc when `ignoreEmpty` is on, but their `lang` still applies to
// the code generated from the template.
const LANG_ATTR_RE = /\slang\s*=\s*["']?([jt]sx?)\b/

function skipWhitespace(raw: string, index: number): number {
  while (index < raw.length && raw[index]!.trim() === '') {
    index++
  }
  return index
}

function isScriptClose(raw: string, index: number): boolean {
  index = skipWhitespace(raw, index)
  if (!raw.startsWith('</script', index)) {
    return false
  }
  return raw[skipWhitespace(raw, index + '</script'.length)] === '>'
}

function findEmptyScriptLang(raw: string): string | undefined {
  let start = raw.indexOf('<script')
  while (start !== -1) {
    const end = raw.indexOf('>', start)
    if (end === -1) {
      return
    }
    const attrs = raw.slice(start + '<script'.length, end)
    const lang = LANG_ATTR_RE.exec(attrs)?.[1]
    if (lang && (attrs.endsWith('/') || isScriptClose(raw, end + 1))) {
      return lang
    }
    start = raw.indexOf('<script', end)
  }
}

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

  const emptyScriptLang = findEmptyScriptLang(raw)
  return isKnownLang(emptyScriptLang) ? emptyScriptLang : 'js'
}

function isKnownLang(lang?: string): lang is KnownSFCLang {
  return lang === 'ts' || lang === 'tsx' || lang === 'jsx' || lang === 'js'
}
