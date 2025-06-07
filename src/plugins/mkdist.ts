import type { LoaderFile } from '../block-loader/types'
import type { VueSFCTransformerFileLoader } from '../sfc-transormer'
import type { Loader } from '../types/mkdist'
import { resolve } from 'node:path'
import { scriptLoader } from '../block-loader/script'
import { styleLoader } from '../block-loader/style'
import { templateLoader } from '../block-loader/template'
import { defineVueSFCTransformer } from '../sfc-transormer'

const vueSFCTransformer = defineVueSFCTransformer({
  blockLoaders: {
    template: templateLoader,
    script: scriptLoader,
    style: styleLoader,
  },
})

export const vueLoader: Loader = async (input, mkdistContext) => {
  if (input.extension !== '.vue') {
    return
  }

  const { transform } = await import('esbuild')
  const path = input.path
  const srcPath = input.srcPath || resolve(input.path)

  const loadFile: VueSFCTransformerFileLoader = async (file, context) => {
    if (context.block.type === 'script') {
      const { code } = await transform(file.content, {
        ...mkdistContext.options.esbuild,
        loader: 'ts',
        tsconfigRaw: { compilerOptions: { target: 'ESNext', verbatimModuleSyntax: true } },
      })

      return [{ extension: '.js', content: code }]
    }

    const result = await mkdistContext.loadFile({
      getContents: () => file.content,
      path: `${path}.${file.extension}`,
      srcPath: `${srcPath}.${file.extension}`,
      extension: file.extension,
    })

    return (result
      ?.filter(res => res.contents)
      .map(res => ({
        extension: res.extension || file.extension,
        content: res.contents,
      })) || []) as LoaderFile[]
  }

  const result = await vueSFCTransformer(await input.getContents(), {
    path: input.path,
    srcPath: input.srcPath || resolve(input.path),
    loadFile,
    // @ts-expect-error internal flag for testing
    verifySFC: mkdistContext.options._verify,
  })

  // generate dts
  const dts = (await mkdistContext.loadFile({
    path: `${input.path}.js`,
    srcPath: `${input.srcPath}.js`,
    extension: '.js',
    getContents: () => 'export default {}',
  }))?.filter(f => f.declaration) || []

  return [
    {
      path: input.path,
      srcPath: input.srcPath,
      extension: '.vue',
      contents: result,
      declaration: false,
    },
    ...dts,
  ]
}
