import { describe, expect, it } from 'vitest'
import { welcome } from '../src'

describe('vue-sfc-transformer', () => {
  it('works', () => {
    expect(welcome()).toMatchInlineSnapshot('"hello world"')
  })
})
