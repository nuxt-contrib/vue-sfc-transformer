import type { SFCTemplateBlock } from 'vue/compiler-sfc'
import type { BlockLoader, LoadFileContext } from './types'
import { transpileVueTemplate } from '../utils/template'

const templateJsSnippetValidExtensions = new Set(['.js', '.cjs', '.mjs'])

export const templateLoader: BlockLoader = async (block, { isTs, loadFile }) => {
  if (block.type !== 'template') {
    return
  }
  if (!isTs) {
    return
  }

  const typedBlock = block as SFCTemplateBlock

  const snippetExtension = isTs ? '.ts' : '.js'
  const context: LoadFileContext = { isTs, block }

  const transformed = await transpileVueTemplate(
    // for lower version of @vue/compiler-sfc, `ast.source` is the whole .vue file
    typedBlock.content,
    typedBlock.ast!,
    typedBlock.loc.start.offset,
    async (code) => {
      const res = await loadFile(
        { extension: snippetExtension, content: code },
        context,
      )

      return res?.find(f => templateJsSnippetValidExtensions.has(f.extension))?.content || code
    },
  )

  return {
    type: 'template',
    attrs: typedBlock.attrs,
    content: transformed,
  }
}
