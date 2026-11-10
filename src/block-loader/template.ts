import type { SFCTemplateBlock } from 'vue/compiler-sfc'
import type { BlockLoader } from './types'
import { transpileVueTemplate } from '../utils/template'

export const templateLoader: BlockLoader = async (block, { isTs }) => {
  if (block.type !== 'template') {
    return
  }
  if (!isTs) {
    return
  }

  const typedBlock = block as SFCTemplateBlock

  const transformed = await transpileVueTemplate(
    // for lower version of @vue/compiler-sfc, `ast.source` is the whole .vue file
    typedBlock.content,
    typedBlock.ast!,
    typedBlock.loc.start.offset,
  )

  return {
    type: 'template',
    attrs: typedBlock.attrs,
    content: transformed,
  }
}
