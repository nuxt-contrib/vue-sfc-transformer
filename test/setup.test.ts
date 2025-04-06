import { describe, expect, it } from 'vitest'
import { parse } from 'vue/compiler-sfc'
import { preTranspileScriptSetup } from '../src/utils/script-setup'

describe('transform typescript script setup', () => {
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
