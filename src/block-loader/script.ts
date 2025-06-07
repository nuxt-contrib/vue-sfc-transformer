import type { BlockLoader, LoaderFile, LoadFileContext } from './types'
import { toOmit } from '../utils/object'

const scriptValidExtensions = new Set(['.js', '.cjs', '.mjs'])

export const scriptLoader: BlockLoader = async (block, { isTs, loadFile }) => {
  if (block.type !== 'script') {
    return
  }

  const extension = isTs ? '.ts' : '.js'

  const input: LoaderFile = { extension, content: block.content }
  const context: LoadFileContext = { isTs, block }

  const files = await loadFile(input, context) || []

  const output = files.find(file => scriptValidExtensions.has(file.extension))
  if (!output) {
    return
  }

  return {
    type: block.type,
    attrs: toOmit(block.attrs, ['lang', 'generic']),
    content: output.content,
  }
}
