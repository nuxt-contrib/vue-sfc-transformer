import type { SFCBlock, SFCParseResult } from 'vue/compiler-sfc'

export interface LoaderFile {
  extension: string
  content: string
}

export interface LoadFileContext {
  isTs: boolean
  block: SFCBlock
}

export interface BlockLoaderContext {
  /**
   * Whether the SFC is using TypeScript
   */
  isTs: boolean

  /**
   * Relative path to the SFC
   */
  path: string

  /**
   * Absolute path to the SFC
   */
  srcPath: string

  /**
   * Raw content of the SFC
   */
  raw: string

  /**
   * Parsed SFC
   */
  sfc: SFCParseResult

  loadFile: (input: LoaderFile, context: LoadFileContext) => Promise<LoaderFile[]> | LoaderFile[]
}

type BlockLoaderOutput = Pick<SFCBlock, 'type' | 'content' | 'attrs'>

export interface BlockLoader {
  (
    block: SFCBlock,
    context: BlockLoaderContext,
  ): Promise<BlockLoaderOutput | undefined>
}
