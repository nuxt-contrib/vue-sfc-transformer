// TODO: export from mkdist

export interface InputFile {
  path: string
  extension: string
  srcPath?: string
  getContents: () => Promise<string> | string
}

export interface OutputFile {
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

export type LoaderResult = OutputFile[] | undefined

export interface LoaderContext {
  loadFile: (input: InputFile) => LoaderResult | Promise<LoaderResult>
}

export type Loader = (input: InputFile, context: LoaderContext) => LoaderResult | Promise<LoaderResult>
