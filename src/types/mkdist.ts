// TODO: export from mkdist

import type { MkdistOptions } from 'mkdist'

interface InputFile {
  path: string
  extension: string
  srcPath?: string
  getContents: () => Promise<string> | string
}

interface OutputFile {
  /**
   * relative to distDir
   */
  path: string
  srcPath?: string
  extension?: string
  contents?: string
  declaration?: boolean
  errors?: Error[]
  raw?: boolean
  skip?: boolean
}

type LoaderResult = OutputFile[] | undefined

interface LoaderContext {
  loadFile: (input: InputFile) => LoaderResult | Promise<LoaderResult>
  options: MkdistOptions
}

export type Loader = (input: InputFile, context: LoaderContext) => LoaderResult | Promise<LoaderResult>
