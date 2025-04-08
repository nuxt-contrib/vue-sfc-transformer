import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdist } from 'mkdist'
import { afterAll, describe, expect, it } from 'vitest'
import { vueLoader } from '../src/mkdist'

describe('transform typescript script setup', () => {
  const tmpDir = fileURLToPath(new URL('../node_modules/.tmp/fixtures', import.meta.url))
  afterAll(async () => {
    await rm(tmpDir, { force: true, recursive: true })
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
      });
      </script>
      "
    `)
    expect(
      await fixture(
        `<script setup lang="ts">const props = defineProps<{ msg: string }>()</script>`,
      ),
    ).toMatchInlineSnapshot(`
      "<script setup>
      const props = defineProps({
        msg: { type: String, required: true }
      });
      </script>
      "
    `)
    expect(
      await fixture(
        `<script setup lang="ts">const { msg } = defineProps<{ msg: string }>()</script>`,
      ),
    ).toMatchInlineSnapshot(`
      "<script setup>
      const { msg } = defineProps({
        msg: { type: String, required: true }
      });
      </script>
      "
    `)
    expect(
      await fixture(
        `<script setup lang="ts">const { msg = 'hello' } = defineProps<{ msg?: string }>()</script>`,
      ),
    ).toMatchInlineSnapshot(`
      "<script setup>
      const { msg = "hello" } = defineProps({
        msg: { type: String, required: false }
      });
      </script>
      "
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
        msg: { type: String, required: false, default: "hi" }
      });
      </script>
      "
    `)
    expect(
      await fixture(
        `<script setup lang="ts">withDefaults(defineProps<{ msg?: string }>(), { msg: 'hi' })</script>`,
      ),
    ).toMatchInlineSnapshot(`
      "<script setup>
      defineProps({
        msg: { type: String, required: false, default: "hi" }
      });
      </script>
      "
    `)
  })

  it('defineEmits', async () => {
    expect(
      await fixture(
        `<script setup lang="ts">const emit = defineEmits<{ click: [] }>()</script>`,
      ),
    ).toMatchInlineSnapshot(`
      "<script setup>
      const emit = defineEmits(["click"]);
      </script>
      "
    `)
    expect(
      await fixture(
        `<script setup lang="ts">defineEmits<{ click: [] }>()</script>`,
      ),
    ).toMatchInlineSnapshot(`
      "<script setup>
      defineEmits(["click"]);
      </script>
      "
    `)
    expect(
      await fixture(
        `<script setup lang="ts">defineEmits<{ click: [msg: string] }>()</script>`,
      ),
    ).toMatchInlineSnapshot(`
      "<script setup>
      defineEmits(["click"]);
      </script>
      "
    `)
    expect(
      await fixture(
        `<script setup lang="ts">defineEmits<{ (e: 'click'): any }>()</script>`,
      ),
    ).toMatchInlineSnapshot(`
      "<script setup>
      defineEmits(["click"]);
      </script>
      "
    `)
    expect(
      await fixture(
        `<script setup lang="ts">defineEmits<{ (e: 'click', msg: string): any }>()</script>`,
      ),
    ).toMatchInlineSnapshot(`
      "<script setup>
      defineEmits(["click"]);
      </script>
      "
    `)
  })

  it('defineModel', async () => {
    expect(
      await fixture(
        `<script setup lang="ts">const model = defineModel<string>()</script>`,
      ),
    ).toMatchInlineSnapshot(`
      "<script setup>
      const model = defineModel({ type: String });
      </script>
      "
    `)
    expect(
      await fixture(`<script setup lang="ts">defineModel<string>()</script>`),
    ).toMatchInlineSnapshot(`
      "<script setup>
      defineModel({ type: String });
      </script>
      "
    `)
    expect(
      await fixture(
        `<script setup lang="ts">defineModel<string>('msg')</script>`,
      ),
    ).toMatchInlineSnapshot(`
      "<script setup>
      defineModel("msg", { type: String });
      </script>
      "
    `)
    expect(
      await fixture(
        `<script setup lang="ts">defineModel<string>({ required: true })</script>`,
      ),
    ).toMatchInlineSnapshot(`
      "<script setup>
      defineModel({ type: String, ...{ required: true } });
      </script>
      "
    `)
    expect(
      await fixture(
        `<script setup lang="ts">defineModel<string>('msg', { required: true })</script>`,
      ),
    ).toMatchInlineSnapshot(`
      "<script setup>
      defineModel("msg", { type: String, ...{ required: true } });
      </script>
      "
    `)
  })

  it('do not tree-shake', async () => {
    expect(
      await fixture(
        `<template>
            <div :data-test="toValue('hello')" />
          </template>
          <script setup lang="ts">
          import { toValue, type Ref } from 'vue'
          const msg = 1
          </script>`,
      ),
    ).toMatchInlineSnapshot(`
      "<template>
                  <div :data-test="toValue('hello')" />
      </template>

      <script setup>
      import { toValue } from "vue";
      const msg = 1;
      </script>
      "
    `)
  })

  it('generates declaration', { timeout: 10000 }, async () => {
    const src = `
      <template>
        <div :data-test="toValue('hello')" />
      </template>

      <script>
        export default { name: 'App' }
      </script>

      <script setup lang="ts">
      defineProps<{ msg: string }>()
      import { toValue, type Ref } from 'vue'
      const msg = 1
      </script>`

    expect(await declaration(src)).toMatchInlineSnapshot(`
      "declare const _default: import("vue").DefineComponent<{
          msg: string;
      }, {}, {}, {}, {}, import("vue").ComponentOptionsMixin, import("vue").ComponentOptionsMixin, {}, string, import("vue").PublicProps, Readonly<{
          msg: string;
      }> & Readonly<{}>, {}, {}, {}, {}, string, import("vue").ComponentProvideOptions, false, {}, any>;
      export default _default;
      "
    `)
  })

  async function fixture(src: string): Promise<string> {
    await rm(tmpDir, { force: true, recursive: true })
    await mkdir(join(tmpDir, 'src'), { recursive: true })
    await writeFile(join(tmpDir, 'src/index.vue'), src)
    await mkdist({
      loaders: ['js', vueLoader],
      rootDir: tmpDir,
      // @ts-expect-error internal flag for testing
      _verify: true,
    })
    return await readFile(join(tmpDir, 'dist/index.vue'), 'utf-8')
  }

  async function declaration(src: string): Promise<string> {
    await rm(tmpDir, { force: true, recursive: true })
    await mkdir(join(tmpDir, 'src'), { recursive: true })
    await writeFile(join(tmpDir, 'src/index.vue'), src)
    await mkdist({ declaration: true, loaders: ['js', vueLoader], rootDir: tmpDir })
    return await readFile(join(tmpDir, 'dist/index.vue.d.ts'), 'utf-8')
  }
})
