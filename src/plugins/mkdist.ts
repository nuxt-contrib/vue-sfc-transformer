import type { LoaderFile } from '../block-loader/types'
import type { VueSFCTransformerFileLoader } from '../sfc-transformer'
import type { Loader } from '../types/mkdist'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { scriptLoader } from '../block-loader/script'
import { styleLoader } from '../block-loader/style'
import { templateLoader } from '../block-loader/template'
import { defineVueSFCTransformer } from '../sfc-transformer'

let cachedEsbuild: typeof import('esbuild') | undefined
function importEsbuild(): Promise<typeof import('esbuild')> | typeof import('esbuild') {
  if (cachedEsbuild) {
    return cachedEsbuild
  }
  return (async () => {
    const esbuild = await import('esbuild')
    cachedEsbuild = esbuild
    return esbuild
  })()
}

let _isMkdistSupportDualVueDts: boolean | undefined
function isMkdistSupportDualVueDts(): boolean {
  if (typeof _isMkdistSupportDualVueDts === 'boolean') {
    return _isMkdistSupportDualVueDts
  }
  try {
    const require = createRequire(import.meta.url)
    const mkdistPath = require.resolve('mkdist').replace(/\\/g, '/')
    const lastNodeModules = mkdistPath.lastIndexOf('/mkdist/')
    const withoutDist = lastNodeModules !== -1 ? mkdistPath.slice(0, lastNodeModules) : mkdistPath
    const packageJson = readFileSync(join(withoutDist, 'mkdist/package.json'), 'utf-8')
    const { version = '0.0.0' } = JSON.parse(packageJson) as { version: string }
    const [major = 0, minor = 0, patch = 0] = version.split('.').map(n => Number.parseInt(n))
    const normalizedVersion = major * 1_000_000 + minor * 1_000 + patch

    return !Number.isNaN(normalizedVersion) && normalizedVersion > 2_003_000
  }
  catch (error) {
    console.error(`Error checking mkdist version: ${error}`)
    return false
  }
}

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

  const { transform } = await importEsbuild()
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
  if (dts.length && isMkdistSupportDualVueDts()) {
    dts.push({
      contents: await input.getContents(),
      path: input.path,
      srcPath: input.srcPath,
      extension: '.d.vue.ts',
      declaration: true,
    })
  }

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
