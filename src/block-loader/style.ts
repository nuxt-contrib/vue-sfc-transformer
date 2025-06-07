import { defineDefaultBlockLoader } from './default'

export const styleLoader = defineDefaultBlockLoader({
  defaultLang: 'css',
  type: 'style',
})
