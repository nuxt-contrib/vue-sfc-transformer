import { describe, expect, it } from 'vitest'
import { transpileScriptBlock } from '../src/utils/script-transpile'

describe('transpileScriptBlock', () => {
  it('blanks type-only syntax without throwing', () => {
    const output = transpileScriptBlock([
      `import type { CSSProperties } from 'vue'`,
      `interface Props { msg: string }`,
      `const style: CSSProperties = { color: 'red' }`,
      `const flags = { a: 1 } as const`,
      `enum Direction { Up, Down }`,
    ].join('\n'), 'ts', 'App.vue')

    expect(output).not.toMatch(/interface|:\s*CSSProperties|import type/)
  })

  it('preserves JSX in tsx without false positives', () => {
    const output = transpileScriptBlock(
      'const vnode = <div>{msg as string}</div>',
      'tsx',
      'App.vue',
    )

    expect(output).toContain('<div>')
    expect(output).not.toContain('as string')
  })

  it('throws on a parameter property with file and position info', () => {
    const code = 'class Button {\n  constructor(private label: string) {}\n}'
    const error = catchError(() => transpileScriptBlock(code, 'ts', 'src/App.vue'))

    expect(error.message).toContain('src/App.vue')
    expect(error.message).toContain('runtime semantics that cannot be erased')
    expect(error.message).toContain('TSParameterProperty at 2:15: private label')
  })

  it('lists every unsupported construct in one error', () => {
    const code = 'namespace Util {\n  export const a = 1\n}\nconst x = <string>y'
    const error = catchError(() => transpileScriptBlock(code, 'ts', 'App.vue'))

    expect(error.message).toContain('TSModuleDeclaration')
    expect(error.message).toContain('TSTypeAssertion')
  })

  it('truncates long unsupported spans', () => {
    const body = Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i}`).join('\n  ')
    const error = catchError(() => transpileScriptBlock(`namespace Big {\n  ${body}\n}`, 'ts', 'App.vue'))

    expect(error.message).toContain('...')
    expect(error.message.length).toBeLessThan(500)
  })
})

function catchError(fn: () => unknown): Error {
  try {
    fn()
  }
  catch (error) {
    return error as Error
  }
  throw new Error('expected transpileScriptBlock to throw')
}
