import type { BlockLoader, LoaderFile, LoadFileContext } from './types'
import { toOmit } from '../utils/object'

interface DefaultBlockLoaderOptions {
  type: 'script' | 'style' | 'template' | (string & {})
  defaultLang: string
  validExtensions?: string[]
}

export function defineDefaultBlockLoader(
  options: DefaultBlockLoaderOptions,
): BlockLoader {
  return async (block, { isTs, loadFile }) => {
    if (options.type !== block.type) {
      return
    }

    const lang = typeof block.attrs.lang === 'string'
      ? block.attrs.lang
      : options.defaultLang
    const extension = `.${lang}`

    const input: LoaderFile = { extension, content: block.content }
    const context: LoadFileContext = { isTs, block }
    const files = await loadFile(input, context) || []

    const output = files.find(
      file => file.extension === `.${options.defaultLang}` || options.validExtensions?.includes(file.extension),
    )
    if (!output) {
      return
    }

    return {
      type: block.type,
      attrs: toOmit(block.attrs, ['lang', 'generic']),
      content: output.content,
    }
  }
}
