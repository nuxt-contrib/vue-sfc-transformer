import { createRequire } from 'node:module'
import { resolveModulePath } from 'exsolve'
import { describe, expect, it } from 'vitest'
import { transpileVueTemplate } from '../src/utils/template'

describe('transform typescript template', () => {
  it('v-for', async () => {
    expect(await fixture(`<div v-for="item in items as unknown[]" :key="item">{{ item }}</div>`))
      .toMatchInlineSnapshot(`"<div v-for="item in items             " :key="item">{{ item }}</div>"`)

    expect(await fixture(`<div v-for="(item, index) in items as unknown[]" :key="item" :index>{{ item }}</div>`))
      .toMatchInlineSnapshot(`"<div v-for="(item, index) in items             " :key="item" :index>{{ item }}</div>"`)

    expect(await fixture(`<div v-for="(item, index) of items" />`))
      .toMatchInlineSnapshot(`"<div v-for="(item, index) of items" />"`)

    expect(await fixture(`<div v-for="({ name = 'Tony' }, index) of items" />`))
      .toMatchInlineSnapshot(`"<div v-for="({ name = 'Tony' }, index) of items" />"`)
  })

  it('v-if', async () => {
    expect(await fixture(`<div v-if="(data as any).test" />`))
      .toMatchInlineSnapshot(`"<div v-if="(data       ).test" />"`)
  })

  it('v-show', async () => {
    expect(await fixture(`<div v-show="(data as any).show" />`)).toMatchInlineSnapshot(
      `"<div v-show="(data       ).show" />"`,
    )
  })

  it('v-model', async () => {
    expect(await fixture(`<input v-model="(data as string)" />`)).toMatchInlineSnapshot(
      `"<input v-model="(data          )" />"`,
    )
  })

  it('v-on', async () => {
    expect(
      await fixture(`<div @click="handleClick as () => void" />`),
    ).toMatchInlineSnapshot(`"<div @click="handleClick              " />"`)
    expect(await fixture(`<div @click="handleClick()" />`)).toMatchInlineSnapshot(
      `"<div @click="handleClick()" />"`,
    )
    expect(
      await fixture(
        `<div @click="(e: unknown) => handleClick(e as MouseEvent)" />`,
      ),
    ).toMatchInlineSnapshot(`"<div @click="(e         ) => handleClick(e              )" />"`)
    expect(
      await fixture(
        `<div @click="(e: unknown) => { handleClick(e as MouseEvent); ping() }" />`,
      ),
    ).toMatchInlineSnapshot(`"<div @click="(e         ) => { handleClick(e              ); ping() }" />"`)

    // https://github.com/nuxt/module-builder/issues/587#issuecomment-2820414064
    expect(
      await fixture(`<div @click="a(); b()" />`),
    ).toMatchInlineSnapshot(`"<div @click="a(); b()" />"`)
    expect(
      await fixture(`<div @click="a(); () => {}; b()" />`),
    ).toMatchInlineSnapshot(`"<div @click="a(); () => {}; b()" />"`)
  })

  it('v-slot', async () => {
    expect(await fixture(`<Comp><template #header="{ name = 'hi' }">{{ name!.toString() }}</template></Comp>`))
      .toMatchInlineSnapshot(`"<Comp><template #header="{ name = 'hi' }">{{ name .toString() }}</template></Comp>"`)
  })

  it('destructuring', async () => {
    expect(
      await fixture(`<MyComponent v-slot="{ active, ...slotProps }">{{ active }}</MyComponent>`),
    ).toMatchInlineSnapshot(`"<MyComponent v-slot="{ active, ...slotProps }">{{ active }}</MyComponent>"`)

    expect(
      await fixture(
        `<MyComponent v-slot="{ remaining, duration }">{{ remaining }}</MyComponent>`,
      ),
    ).toMatchInlineSnapshot(`"<MyComponent v-slot="{ remaining, duration }">{{ remaining }}</MyComponent>"`)
  })

  it('compound expressions', async () => {
    expect(await fixture(`<slot :name="(foo as string) + bar" />`)).toMatchInlineSnapshot(
      `"<slot :name="(foo          ) + bar" />"`,
    )
  })

  it('custom directives', async () => {
    expect(
      await fixture(`<div v-highlight="(highlight as boolean)" />`),
    ).toMatchInlineSnapshot(`"<div v-highlight="(highlight           )" />"`)
  })

  it('v-bind', async () => {
    expect(await fixture(`<div v-bind="(props as any)" />`)).toMatchInlineSnapshot(
      `"<div v-bind="(props       )" />"`,
    )
    expect(
      await fixture(`<div :key="(value as any)" data-test="test" />`),
    ).toMatchInlineSnapshot(`"<div :key="(value       )" data-test="test" />"`)
    expect(await fixture(`<input disabled />`)).toMatchInlineSnapshot(`"<input disabled />"`)
    expect(await fixture(`<input :disabled />`)).toMatchInlineSnapshot(
      `"<input :disabled />"`,
    )
    expect(await fixture(`<input v-bind:disabled />`)).toMatchInlineSnapshot(
      `"<input v-bind:disabled />"`,
    )
  })

  it('interpolation', async () => {
    expect(await fixture(`<div>{{ data!.test }}</div>`)).toMatchInlineSnapshot(
      `"<div>{{ data .test }}</div>"`,
    )
    expect(await fixture(`<div>hi {{ data!.test }}</div>`)).toMatchInlineSnapshot(
      `"<div>hi {{ data .test }}</div>"`,
    )
    expect(
      await fixture(
        `<div>{{ typeof data!.test === "string" ? data!.test : getKey(data!.test) }}</div>`,
      ),
    ).toMatchInlineSnapshot(
      `"<div>{{ typeof data .test === "string" ? data .test : getKey(data .test) }}</div>"`,
    )
  })

  it('keep comments', async () => {
    expect(
      await fixture(`<div>{{ data!.test }}</div><!-- comment -->`),
    ).toMatchInlineSnapshot(`"<div>{{ data .test }}</div><!-- comment -->"`)
  })

  it('keep text', async () => {
    expect(await fixture(`<div>data!.test</div>`)).toMatchInlineSnapshot(
      `"<div>data!.test</div>"`,
    )
  })

  it('keep empty', async () => {
    expect(await fixture(`<div>{{}}</div>`)).toMatchInlineSnapshot(`"<div>{{}}</div>"`)
    expect(await fixture(`<div @click="" />`)).toMatchInlineSnapshot(`"<div @click="" />"`)
  })

  it('throw error', async () => {
    await expect(fixture(`<div>{{ data. }}</div>`)).rejects.toThrowError()
  })

  it('quotes', async () => {
    expect(await fixture(`<div @click="emit('click')" />`)).toMatchInlineSnapshot(
      `"<div @click="emit('click')" />"`,
    )
    expect(await fixture(`<div @click='emit("click")' />`)).toMatchInlineSnapshot(
      `"<div @click='emit("click")' />"`,
    )
    expect(await fixture(`<div @click="emit('click', '\\'')" />`)).toMatchInlineSnapshot(
      `"<div @click="emit('click', '\\'')" />"`,
    )
  })

  it('equals', async () => {
    expect(
      await fixture(`
      <div>
        <MyComponent #template="{ item, index, level = 0 as 0 | 1 }" />
        <MyComponent #template="{ item, index, level = 0 as 0 | 1 }" />
        <MyComponent #template="{ item, index = 3 as 3 | 4, level }" />
      </div>`),
    ).toMatchInlineSnapshot(`
      "
            <div>
              <MyComponent #template="{ item, index, level = 0          }" />
              <MyComponent #template="{ item, index, level = 0          }" />
              <MyComponent #template="{ item, index = 3         , level }" />
            </div>"
    `)
  })

  it('handles deeply nested templates', async () => {
    const nestedTemplate = `<div><span><p>{{ (data as any).value }}</p></span></div>`
    const result = await fixture(nestedTemplate)
    expect(result).toMatchInlineSnapshot(`"<div><span><p>{{ (data       ).value }}</p></span></div>"`)
  })

  it('handles quotes in interpolations', async () => {
    expect(
      await fixture(`
        <template>
          <div>
            <div :class="$test('foobar', \`Foobar 'test'\`)" />
            <div>{{ $test('foobar', "Foobar 'test'") }}</div>
            <div>{{ $test('foobar', 'Foobar test') }}</div>
            <div>{{ $test('foobar', \`Foobar ' " ''" test\`) }}</div>
          </div>
        </template>
        `),
    ).toMatchInlineSnapshot(`
      "
              <template>
                <div>
                  <div :class="$test('foobar', \`Foobar 'test'\`)" />
                  <div>{{ $test('foobar', "Foobar 'test'") }}</div>
                  <div>{{ $test('foobar', 'Foobar test') }}</div>
                  <div>{{ $test('foobar', \`Foobar ' " ''" test\`) }}</div>
                </div>
              </template>
              "
    `)
  })

  async function fixture(src: string) {
    const requireFromVue = createRequire(resolveModulePath('vue'))
    const { parse } = requireFromVue('@vue/compiler-dom') as typeof import('@vue/compiler-dom')

    return await transpileVueTemplate(
      src,
      parse(src, { parseMode: 'base' }),
      0,
    )
  }
})
