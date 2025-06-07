import type { SFCBlock } from 'vue/compiler-sfc'
import type { BlockLoader, BlockLoaderContext, LoaderFile, LoadFileContext } from './block-loader/types'
import { preTranspileScriptSetup } from './utils/script-setup'
import { cleanupBreakLine } from './utils/string'

export type VueSFCTransformerFileLoader = (input: LoaderFile, context: LoadFileContext) => Promise<LoaderFile[]> | LoaderFile[]

export interface VueSFCTransformerContext {
  /**
   * Relative path to the SFC
   */
  path: string

  /**
   * Absolute path to the SFC
   */
  srcPath: string

  /**
   * Whether to verify the SFC
   */
  verifySFC?: boolean

  loadFile: VueSFCTransformerFileLoader
}

export interface VueSFCTransformerOptions {
  blockLoaders?: {
    [blockType: string]: BlockLoader | undefined
  }
}

export type VueSFCTransformer = (input: string, context: VueSFCTransformerContext) => Promise<string>

export function defineVueSFCTransformer(options?: VueSFCTransformerOptions): VueSFCTransformer {
  const { blockLoaders = {} } = options || {}

  return async (input, { path, srcPath, loadFile, verifySFC }) => {
    const { parse } = await import('vue/compiler-sfc')

    let modified = false

    const sfc = parse(input, { filename: srcPath, ignoreEmpty: true })
    if (sfc.errors.length > 0) {
      for (const error of sfc.errors) {
        console.error(error)
      }
      throw new Error(`[vue-sfc-transformer] ${srcPath} has errors`)
    }

    // we need to remove typescript from template block if the block is typescript
    const isTs = [sfc.descriptor.script, sfc.descriptor.scriptSetup].some(
      block => block?.lang === 'ts',
    )

    const blocks: SFCBlock[] = [
      ...sfc.descriptor.styles,
      ...sfc.descriptor.customBlocks,
    ].filter(item => !!item)

    if (sfc.descriptor.template) {
      blocks.unshift(sfc.descriptor.template)
    }

    if (sfc.descriptor.script) {
      blocks.unshift(sfc.descriptor.script)
    }
    if (sfc.descriptor.scriptSetup && srcPath) {
      blocks.unshift(
        isTs
          ? await preTranspileScriptSetup(sfc.descriptor, srcPath)
          : sfc.descriptor.scriptSetup,
      )
    }

    const loaderContext: BlockLoaderContext = { isTs, path, srcPath, raw: input, sfc, loadFile }
    const results = await Promise.all(blocks.map(async (block) => {
      const blockLoader = blockLoaders[block.type]
      const result = await blockLoader?.(block, loaderContext).catch((cause) => {
        throw new Error(`[vue-sfc-transformer] Failed to load the ${block.type} block in ${srcPath}`, { cause })
      })

      if (result) {
        modified = true
      }

      return { block: result || block, offset: block.loc.start.offset }
    }))

    if (!modified) {
      return input
    }

    const contents = results
      .sort((a, b) => a.offset - b.offset)
      .map(({ block }) => {
        const attrs = Object.entries(block.attrs)
          .map(([key, value]) => {
            if (!value) {
              return undefined
            }

            return value === true ? key : `${key}="${value}"`
          })
          .filter(item => !!item)
          .join(' ')

        const header = `<${`${block.type} ${attrs}`.trim()}>`
        const footer = `</${block.type}>`

        return `${header}\n${cleanupBreakLine(block.content)}\n${footer}\n`
      })
      .filter(item => !!item)
      .join('\n')

    // eslint-disable-next-line node/prefer-global/process
    if (verifySFC || process.env.VERIFY_VUE_FILES) {
      // verify the output
      const { parse } = await import('vue/compiler-sfc')
      const { errors } = parse(contents, {
        filename: srcPath,
        ignoreEmpty: true,
      })
      if (errors.length > 0) {
        for (const error of errors) {
          console.error(error)
        }
        throw new Error(`[vue-sfc-transformer] ${srcPath} has errors`)
      }
    }

    return contents
  }
}
