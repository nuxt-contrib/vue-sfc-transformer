import { describe, expect, it } from 'vitest'

import { getSfcScriptLang } from '../src/utils/script-lang'

describe('getSfcScriptLang', () => {
  it('uses the first block with a known lang', () => {
    expect(getSfcScriptLang('', { lang: 'css' }, { lang: 'tsx' }, { lang: 'ts' })).toBe('tsx')
  })

  it.each([
    ['<script lang="ts"></script>', 'ts'],
    ['<script setup lang=\'tsx\'>\n  </script >', 'tsx'],
    ['<script lang=ts />', 'ts'],
    ['<template><div /></template>\n<script lang="jsx"/>', 'jsx'],
    ['<script>const a = 1</script>\n<script lang="ts"></script>', 'ts'],
  ])('reads the lang of an empty script block in %j', (raw, lang) => {
    expect(getSfcScriptLang(raw)).toBe(lang)
  })

  it.each([
    '<script lang="ts">const a = 1</script>',
    '<script data-lang="ts"></script>',
    '<script lang="tsfoo"></script>',
    '<template><div /></template>',
  ])('falls back to js for %j', (raw) => {
    expect(getSfcScriptLang(raw)).toBe('js')
  })

  it('runs in linear time on repeated script tags', () => {
    const start = performance.now()
    expect(getSfcScriptLang('<script'.repeat(20_000))).toBe('js')
    expect(getSfcScriptLang('<script lang="ts">'.repeat(20_000))).toBe('js')
    expect(performance.now() - start).toBeLessThan(250)
  })
})
