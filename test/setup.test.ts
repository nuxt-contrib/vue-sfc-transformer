import { describe, expect, it } from 'vitest'
import { parse } from 'vue/compiler-sfc'
import { preTranspileScriptSetup } from '../src/utils/script-setup'

describe('transform typescript script setup', () => {
  it('throws error if no script setup block is present', async () => {
    const sfc = parse(`<template><div></div></template><script></script>`, {
      filename: 'test.vue',
      ignoreEmpty: true,
    })
    await expect(preTranspileScriptSetup(sfc.descriptor, 'test.vue')).rejects.toThrow(
      '[vue-sfc-transformer] No script setup block found',
    )
  })

  it('defineProps', async () => {
    expect(
      await fixture(
        `<script setup lang="ts">defineProps<{ msg: string }>()</script>`,
      ),
    ).toMatchInlineSnapshot(`
      "<script setup>
      defineProps({
          msg: { type: String, required: true }
        })
      </script>"
    `)
    expect(
      await fixture(
        `<script setup lang="ts">const props = defineProps<{ msg: string }>()</script>`,
      ),
    ).toMatchInlineSnapshot(`
      "<script setup>
      const props = defineProps({
          msg: { type: String, required: true }
        })
      </script>"
    `)
    expect(
      await fixture(
        `<script setup lang="ts">const { msg } = defineProps<{ msg: string }>()</script>`,
      ),
    ).toMatchInlineSnapshot(`
      "<script setup>
      const { msg } = defineProps({
          msg: { type: String, required: true }
        })
      </script>"
    `)
    expect(
      await fixture(
        `<script setup lang="ts">const { msg = 'hello' } = defineProps<{ msg?: string }>()</script>`,
      ),
    ).toMatchInlineSnapshot(`
      "<script setup>
      const { msg = 'hello' } = defineProps({
          msg: { type: String, required: false }
        })
      </script>"
    `)
    expect(
      await fixture([
        `<script lang="ts">interface PropsData { msg?: string, count: number }</script>`,
        `<script setup lang="ts">const { msg = 'hello' } = defineProps<PropsData>()</script>`,
      ].join('\n')),
    ).toMatchInlineSnapshot(`
      "<script setup>
      const { msg = 'hello' } = defineProps({
          msg: { type: String, required: false },
          count: { type: Number, required: true }
        })
      </script>"
    `)
  })

  it('strips generic from script setup blocks', async () => {
    expect(
      await fixture(
        `
        <script setup lang="ts" generic="T extends Messages = Messages">
        interface AppProps<T extends string = string> {
          locale?: Array<T>
        }
        const props = defineProps<AppProps<T>>()
        </script>`,
      ),
    ).toMatchInlineSnapshot(`
      "<script setup>

              interface AppProps<T extends string = string> {
                locale?: Array<T>
              }
              const props = defineProps({
          locale: { type: Array, required: false }
        })
              
      </script>"
    `)
  })

  it('withDefaults', async () => {
    expect(
      await fixture(
        `<script setup lang="ts">const props = withDefaults(defineProps<{ msg?: string }>(), { msg: 'hi' })</script>`,
      ),
    ).toMatchInlineSnapshot(`
      "<script setup>
      const props = defineProps({
          msg: { type: String, required: false, default: 'hi' }
        })
      </script>"
    `)
    expect(
      await fixture(
        `<script setup lang="ts">withDefaults(defineProps<{ msg?: string }>(), { msg: 'hi' })</script>`,
      ),
    ).toMatchInlineSnapshot(`
      "<script setup>
      defineProps({
          msg: { type: String, required: false, default: 'hi' }
        })
      </script>"
    `)

    await expect(fixture(`<script setup lang="ts">withDefaults(defineProps<{ msg?: string }>())</script>`)).rejects.toThrow(`[vue-sfc-transformer] The 2nd argument of withDefaults is required.`)

    await expect(fixture(`<script setup lang="ts">withDefaults()</script>`)).rejects.toThrow(`[vue-sfc-transformer] withDefaults' first argument must be a defineProps call.`)
  })

  it('defineEmits', async () => {
    expect(
      await fixture(
        `<script setup lang="ts">const emit = defineEmits<{ click: [] }>()</script>`,
      ),
    ).toMatchInlineSnapshot(`
      "<script setup>
      const emit = defineEmits(["click"])
      </script>"
    `)
    expect(
      await fixture(
        `<script setup lang="ts">defineEmits<{ click: [] }>()</script>`,
      ),
    ).toMatchInlineSnapshot(`
      "<script setup>
      defineEmits(["click"])
      </script>"
    `)
    expect(
      await fixture(
        `<script setup lang="ts">defineEmits<{ click: [msg: string] }>()</script>`,
      ),
    ).toMatchInlineSnapshot(`
      "<script setup>
      defineEmits(["click"])
      </script>"
    `)
    expect(
      await fixture(
        `<script setup lang="ts">defineEmits<{ (e: 'click'): any }>()</script>`,
      ),
    ).toMatchInlineSnapshot(`
      "<script setup>
      defineEmits(["click"])
      </script>"
    `)
    expect(
      await fixture(
        `<script setup lang="ts">defineEmits<{ (e: 'click', msg: string): any }>()</script>`,
      ),
    ).toMatchInlineSnapshot(`
      "<script setup>
      defineEmits(["click"])
      </script>"
    `)

    await expect(fixture(`<script setup lang="ts">defineEmits<{ click: [] }>('click')</script>`)).rejects.toThrow(`[vue-sfc-transformer] defineEmits() cannot accept both type and non-type arguments at the same time. Use one or the other.`)
  })

  it('defineModel', async () => {
    expect(
      await fixture(
        `<script setup lang="ts">const model = defineModel<string>()</script>`,
      ),
    ).toMatchInlineSnapshot(`
      "<script setup>
      const model = defineModel({ type: String })
      </script>"
    `)
    expect(
      await fixture(`<script setup lang="ts">defineModel<string>()</script>`),
    ).toMatchInlineSnapshot(`
      "<script setup>
      defineModel({ type: String })
      </script>"
    `)
    expect(
      await fixture(
        `<script setup lang="ts">defineModel<string>('msg')</script>`,
      ),
    ).toMatchInlineSnapshot(`
      "<script setup>
      defineModel("msg", { type: String })
      </script>"
    `)
    expect(
      await fixture(
        `<script setup lang="ts">defineModel<string | number | string[]>('msg')</script>`,
      ),
    ).toMatchInlineSnapshot(`
      "<script setup>
      defineModel("msg", { type: [String,Number,Array] })
      </script>"
    `)
    expect(
      await fixture(
        `<script setup lang="ts">defineModel<string>({ required: true })</script>`,
      ),
    ).toMatchInlineSnapshot(`
      "<script setup>
      defineModel({ type: String, ...{ required: true } })
      </script>"
    `)
    expect(
      await fixture(
        `<script setup lang="ts">defineModel<string>('msg', { required: true })</script>`,
      ),
    ).toMatchInlineSnapshot(`
      "<script setup>
      defineModel("msg", { type: String, ...{ required: true } })
      </script>"
    `)

    await expect(fixture('<script setup lang="ts">defineModel("foo", "bar")</script>')).rejects.toThrow(`[vue-sfc-transformer] defineModel()'s second argument must be an object.`)
  })

  it('handles edge cases in processDefineProps', async () => {
    const script = `<script setup lang=\"ts\">defineProps<{}>()</script>`
    const sfc = parse(script, { filename: 'test.vue', ignoreEmpty: true })
    const result = await preTranspileScriptSetup(sfc.descriptor, 'test.vue')
    expect(result.content).toContain('defineProps({})')
  })

  async function fixture(src: string): Promise<string> {
    const sfc = parse(src, {
      filename: 'test.vue',
      ignoreEmpty: true,
    })
    if (sfc.descriptor.scriptSetup) {
      const result = await preTranspileScriptSetup(sfc.descriptor, 'test.vue')
      return `<script setup>\n${result.content}\n</script>`
    }
    return src
  }
})
