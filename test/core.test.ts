import { transform } from 'rolldown/utils'
import { describe, expect, it, vi } from 'vitest'

import { isDeclarationEmitDiagnostic, transformVueSfc } from '../src/core'

describe('transformVueSfc', () => {
  it('strips TypeScript from scripts and template expressions', async () => {
    const result = await transformVueSfc([
      '<script setup lang="ts" generic="T">',
      'defineProps<{ msg: string }>()',
      'const n: number = 1',
      '</script>',
      '<template><div>{{ (n as number) }}</div></template>',
      '<style scoped>div { color: red }</style>',
    ].join('\n'), '/src/Hello.vue')

    expect(result.lang).toBe('ts')
    expect(result.code).toMatchInlineSnapshot(`
      "<script setup>
      defineProps({ msg: {
      	type: String,
      	required: true
      } });
      const n = 1;
      </script>

      <template>
      <div>{{ n }}</div>
      </template>

      <style scoped>
      div { color: red }
      </style>
      "
    `)
  })

  it('keeps the script of a JavaScript SFC', async () => {
    const result = await transformVueSfc('<script setup>\nconst n = 1\n</script>\n<template><div>{{ n }}</div></template>\n', '/src/Plain.vue')
    expect(result.lang).toBe('js')
    expect(result.code).toContain('<script setup>\nconst n = 1\n</script>')
  })

  it('uses the provided `transform`', async () => {
    const spy = vi.fn(transform)
    const result = await transformVueSfc('<script lang="tsx">\nexport const vnode = <div>{1 as number}</div>\n</script>\n', '/src/Jsx.vue', { transform: spy })
    expect(spy).toHaveBeenCalled()
    expect(result.lang).toBe('tsx')
    expect(result.code).toContain('<script lang="jsx">')
    expect(result.code).toContain('<div>{1}</div>')
  })

  it('throws when the SFC cannot be parsed', async () => {
    await expect(transformVueSfc('<template><div></template>\n', '/src/Broken.vue')).rejects.toThrow('/src/Broken.vue: Element is missing end tag.')
  })

  it('resolves prop types through a virtual tsconfig served via `script.fs`', async () => {
    const id = '/virtual/vue-sfc-transformer/Flags.vue'
    const tsconfigPath = '/virtual/vue-sfc-transformer/tsconfig.json'
    const flagsPath = '/virtual/vue-sfc-transformer/types/flags.ts'

    const tsconfig = JSON.stringify({
      compilerOptions: { paths: { '#alias': ['./types/flags.ts'] } },
    })
    const flags = 'export type Flags = { enabled: boolean }\n'

    const fs = {
      fileExists(file: string): boolean {
        return file === tsconfigPath || file === flagsPath
      },
      readFile(file: string): string | undefined {
        if (file === tsconfigPath)
          return tsconfig
        if (file === flagsPath)
          return flags
        return undefined
      },
    }

    const source = [
      '<script setup lang="ts">',
      'import type { Flags } from \'#alias\'',
      'defineProps<Flags>()',
      '</script>',
    ].join('\n')

    await expect(transformVueSfc(source, id)).rejects.toThrow('Failed to resolve import source "#alias".')

    const result = await transformVueSfc(source, id, { script: { fs } })
    expect(result.code).toContain('type: Boolean')
  })

  it('resolves prop types from `script.globalTypeFiles`', async () => {
    const id = '/virtual/vue-sfc-transformer/Global.vue'
    const globalFile = '/virtual/vue-sfc-transformer/global.d.ts'

    const fs = {
      fileExists(file: string): boolean {
        return file === globalFile
      },
      readFile(file: string): string | undefined {
        if (file === globalFile)
          return 'declare interface GlobalProps { enabled: boolean }\n'
        return undefined
      },
    }

    const source = [
      '<script setup lang="ts">',
      'defineProps<GlobalProps>()',
      '</script>',
    ].join('\n')

    const result = await transformVueSfc(source, id, { script: { fs, globalTypeFiles: [globalFile] } })
    expect(result.code).toContain('type: Boolean')
  })
})

describe('isDeclarationEmitDiagnostic', () => {
  it.each([1005, 1128, 2527, 2742, 2883, 4023, 4058, 4078, 4094, 4118, 5088, 7056, 9005, 9010, 9039])('treats TS%i as emit-affecting', (code) => {
    expect(isDeclarationEmitDiagnostic(code)).toBe(true)
  })

  it.each([2307, 2322, 2345, 4104, 4111, 4114, 18048])('treats TS%i as not emit-affecting', (code) => {
    expect(isDeclarationEmitDiagnostic(code)).toBe(false)
  })

  it('treats syntactic, declaration and options diagnostics as emit-affecting', () => {
    expect(isDeclarationEmitDiagnostic({ code: 1005, kind: 'syntactic' })).toBe(true)
    expect(isDeclarationEmitDiagnostic({ code: 2322, kind: 'declaration' })).toBe(true)
    expect(isDeclarationEmitDiagnostic({ code: 5055, kind: 'options' })).toBe(true)
    expect(isDeclarationEmitDiagnostic({ code: 2322, kind: 'semantic' })).toBe(false)
    expect(isDeclarationEmitDiagnostic({ code: 1192, kind: 'semantic' })).toBe(false)
    expect(isDeclarationEmitDiagnostic({ code: 2742, kind: 'semantic' })).toBe(true)
  })
})
