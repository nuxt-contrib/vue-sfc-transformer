import { createRequire } from 'node:module'
import { transform } from 'esbuild'
import { resolveModulePath } from 'exsolve'
import { describe, expect, it } from 'vitest'
import { transpileVueTemplate } from '../src/utils/template'

describe('transform typescript template', () => {
  it('v-for', async () => {
    expect(await fixture(`<div v-for="item as string in items as unknown[]" :key="item">{{ item }}</div>`))
      .toEqual(`<div v-for="item in items" :key="item">{{ item }}</div>`)

    expect(await fixture(`<div v-for="(item as string, index) in items as unknown[]" :key="item" :index>{{ item }}</div>`))
      .toEqual(`<div v-for="(item, index) in items" :key="item" :index>{{ item }}</div>`)

    expect(await fixture(`<div v-for="(item, index) of items" />`))
      .toEqual(`<div v-for="(item, index) of items" />`)

    expect(await fixture(`<div v-for="({ name = 'Tony' }, index) of items" />`))
      .toEqual(`<div v-for="({ name = 'Tony' }, index) of items" />`)
  })

  it('v-if', async () => {
    expect(await fixture(`<div v-if="(data as any).test" />`))
      .toEqual(`<div v-if="data.test" />`)
  })

  it('v-show', async () => {
    expect(await fixture(`<div v-show="(data as any).show" />`)).toEqual(
      `<div v-show="data.show" />`,
    )
  })

  it('v-model', async () => {
    expect(await fixture(`<input v-model="(data as string)" />`)).toEqual(
      `<input v-model="data" />`,
    )
  })

  it('v-on', async () => {
    expect(
      await fixture(`<div @click="handleClick as () => void" />`),
    ).toEqual(`<div @click="handleClick" />`)
    expect(await fixture(`<div @click="handleClick()" />`)).toEqual(
      `<div @click="handleClick()" />`,
    )
    expect(
      await fixture(
        `<div @click="(e: unknown) => handleClick(e as MouseEvent)" />`,
      ),
    ).toEqual(`<div @click="(e) => handleClick(e)" />`)
    expect(
      await fixture(
        `<div @click="(e: unknown) => { handleClick(e as MouseEvent); ping() }" />`,
      ),
    ).toMatchInlineSnapshot(`
      "<div @click="(e) => {
        handleClick(e);
        ping();
      }" />"
    `)
  })

  it('v-slot', async () => {
    expect(await fixture(`<Comp><template #header="{ name = 'hi' }">{{ name!.toString() }}</template></Comp>`))
      .toMatchInlineSnapshot(`"<Comp><template #header="{ name = 'hi' }">{{ name.toString() }}</template></Comp>"`)
  })

  it('destructuring', async () => {
    expect(
      await fixture(`<MyComponent v-slot="{ active, ...slotProps }">{{ active }}</MyComponent>`),
    ).toEqual(`<MyComponent v-slot="{ active, ...slotProps }">{{ active }}</MyComponent>`)

    expect(
      await fixture(
        `<MyComponent v-slot="{ remaining, duration }">{{ remaining }}</MyComponent>`,
      ),
    ).toMatchInlineSnapshot(`"<MyComponent v-slot="{ remaining, duration }">{{ remaining }}</MyComponent>"`)
  })

  it('compound expressions', async () => {
    expect(await fixture(`<slot :name="(foo as string) + bar" />`)).toEqual(
      `<slot :name="foo + bar" />`,
    )
  })

  it('custom directives', async () => {
    expect(
      await fixture(`<div v-highlight="(highlight as boolean)" />`),
    ).toEqual(`<div v-highlight="highlight" />`)
  })

  it('v-bind', async () => {
    expect(await fixture(`<div v-bind="(props as any)" />`)).toEqual(
      `<div v-bind="props" />`,
    )
    expect(
      await fixture(`<div :key="(value as any)" data-test="test" />`),
    ).toEqual(`<div :key="value" data-test="test" />`)
    expect(await fixture(`<input disabled />`)).toEqual(`<input disabled />`)
    expect(await fixture(`<input :disabled />`)).toEqual(
      `<input :disabled />`,
    )
    expect(await fixture(`<input v-bind:disabled />`)).toEqual(
      `<input v-bind:disabled />`,
    )
  })

  it('interpolation', async () => {
    expect(await fixture(`<div>{{ data!.test }}</div>`)).toEqual(
      `<div>{{ data.test }}</div>`,
    )
    expect(await fixture(`<div>hi {{ data!.test }}</div>`)).toEqual(
      `<div>hi {{ data.test }}</div>`,
    )
    expect(
      await fixture(
        `<div>{{ typeof data!.test === "string" ? data!.test : getKey(data!.test) }}</div>`,
      ),
    ).toEqual(
      `<div>{{ typeof data.test === "string" ? data.test : getKey(data.test) }}</div>`,
    )
  })

  it('keep comments', async () => {
    expect(
      await fixture(`<div>{{ data!.test }}</div><!-- comment -->`),
    ).toEqual(`<div>{{ data.test }}</div><!-- comment -->`)
  })

  it('keep text', async () => {
    expect(await fixture(`<div>data!.test</div>`)).toEqual(
      `<div>data!.test</div>`,
    )
  })

  it('keep empty', async () => {
    expect(await fixture(`<div>{{}}</div>`)).toEqual(`<div>{{}}</div>`)
    expect(await fixture(`<div @click="" />`)).toEqual(`<div @click="" />`)
  })

  it('throw error', async () => {
    await expect(fixture(`<div>{{ data. }}</div>`)).rejects.toThrowError()
  })

  it('quotes', async () => {
    expect(await fixture(`<div @click="emit('click')" />`)).toEqual(
      `<div @click="emit('click')" />`,
    )
    expect(await fixture(`<div @click='emit("click")' />`)).toEqual(
      `<div @click='emit("click")' />`,
    )
    expect(await fixture(`<div @click="emit('click', '\\'')" />`)).toEqual(
      `<div @click="emit('click', '\\'')" />`,
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
              <MyComponent #template="{ item, index, level = 0 }" />
              <MyComponent #template="{ item, index, level = 0 }" />
              <MyComponent #template="{ item, index = 3, level }" />
            </div>"
    `)
  })

  async function fixture(src: string) {
    const requireFromVue = createRequire(resolveModulePath('vue'))
    const { parse } = requireFromVue('@vue/compiler-dom') as typeof import('@vue/compiler-dom')

    return await transpileVueTemplate(
      src,
      parse(src, { parseMode: 'base' }),
      0,
      async (code) => {
        const res = await transform(code, { loader: 'ts', target: 'esnext' })
        return res.code
      },
    )
  }
})
