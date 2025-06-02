import type { SFCBlock, SFCTemplateBlock } from 'vue/compiler-sfc'
import type { InputFile, Loader, LoaderContext, LoaderResult, OutputFile } from '../types/mkdist'
import process from 'node:process'
import { transpile } from '@teages/oxc-blank-space'
import { preTranspileScriptSetup, transpileVueTemplate } from '../index'

interface DefineVueLoaderOptions {
  blockLoaders?: {
    [blockType: string]: VueBlockLoader | undefined
  }
}

type VueBlockOutput = Pick<SFCBlock, 'type' | 'content' | 'attrs'>

interface VueBlockLoaderContext extends LoaderContext {
  requireTranspileTemplate: boolean
  rawInput: InputFile
  addOutput: (...files: OutputFile[]) => void
}

interface VueBlockLoader {
  (
    block: SFCBlock,
    context: VueBlockLoaderContext,
  ): Promise<VueBlockOutput | undefined>
}

interface DefaultBlockLoaderOptions {
  type: 'script' | 'style' | 'template'
  defaultLang: string
  validExtensions?: string[]
}

function defineVueLoader(options?: DefineVueLoaderOptions): Loader {
  const blockLoaders = options?.blockLoaders || {}

  return async (input, context) => {
    if (input.extension !== '.vue') {
      return
    }

    const { parse } = await import('vue/compiler-sfc')

    let modified = false

    const raw = await input.getContents()
    const sfc = parse(raw, {
      filename: input.srcPath,
      ignoreEmpty: true,
    })
    if (sfc.errors.length > 0) {
      for (const error of sfc.errors) {
        console.error(error)
      }
      throw new Error(`[vue-sfc-transformer] ${input.srcPath} has errors`)
    }

    // we need to remove typescript from template block if the block is typescript
    const isTs = [sfc.descriptor.script, sfc.descriptor.scriptSetup].some(
      block => block?.lang === 'ts',
    )

    const output: LoaderResult = []
    const addOutput = (...files: OutputFile[]) => output.push(...files)

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
    if (sfc.descriptor.scriptSetup && input.srcPath) {
      blocks.unshift(
        isTs
          ? await preTranspileScriptSetup(sfc.descriptor, input.srcPath)
          : sfc.descriptor.scriptSetup,
      )
    }

    // generate dts
    const files = await context.loadFile({
      path: `${input.path}.js`,
      srcPath: `${input.srcPath}.js`,
      extension: '.js',
      getContents: () => 'export default {}',
    })
    addOutput(...files?.filter(f => f.declaration) || [])

    const results = await Promise.all(
      blocks.map(async (data) => {
        const blockLoader = blockLoaders[data.type]
        const result = await blockLoader?.(data, {
          ...context,
          rawInput: input,
          addOutput,
          requireTranspileTemplate: isTs,
        }).catch((cause) => {
          throw new Error(`[vue-sfc-transformer] Failed to load the ${data.type} block in ${input.srcPath}`, { cause })
        })

        if (result) {
          modified = true
        }
        return { block: result || data, offset: data.loc.start.offset }
      }),
    )

    if (!modified) {
      addOutput({
        path: input.path,
        srcPath: input.srcPath,
        extension: '.vue',
        contents: raw,
        declaration: false,
      })
      return output
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

    // @ts-expect-error internal flag for testing
    if (context.options._verify || process.env.VERIFY_VUE_FILES) {
      // verify the output
      const { parse } = await import('vue/compiler-sfc')
      const { errors } = parse(contents, {
        filename: input.srcPath,
        ignoreEmpty: true,
      })
      if (errors.length > 0) {
        for (const error of errors) {
          console.error(error)
        }
        throw new Error(`[vue-sfc-transformer] ${input.srcPath} has errors`)
      }
    }

    addOutput({
      path: input.path,
      srcPath: input.srcPath,
      extension: '.vue',
      contents,
      declaration: false,
    })

    return output
  }
}

export function defineDefaultBlockLoader(options: DefaultBlockLoaderOptions): VueBlockLoader {
  return async (block, { loadFile, rawInput, addOutput }) => {
    if (options.type !== block.type) {
      return
    }

    const lang = typeof block.attrs.lang === 'string' ? block.attrs.lang : options.defaultLang
    const extension = `.${lang}`

    const files = await loadFile({
      getContents: () => block.content,
      path: `${rawInput.path}${extension}`,
      srcPath: `${rawInput.srcPath}${extension}`,
      extension,
    }) || []

    const blockOutputFile = files.find(f =>
      f.extension === `.${options.defaultLang}` || options.validExtensions?.includes(f.extension as string),
    )
    if (!blockOutputFile) {
      return
    }
    addOutput(...files.filter(f => f !== blockOutputFile))

    return {
      type: block.type,
      attrs: toOmit(block.attrs, ['lang', 'generic']),
      content: blockOutputFile.contents!,
    }
  }
}

const templateLoader: VueBlockLoader = async (
  rawBlock,
  { requireTranspileTemplate },
) => {
  if (rawBlock.type !== 'template') {
    return
  }

  if (!requireTranspileTemplate) {
    return
  }

  const block = rawBlock as SFCTemplateBlock

  const transformed = await transpileVueTemplate(
    // for lower version of @vue/compiler-sfc, `ast.source` is the whole .vue file
    block.content,
    block.ast!,
    block.loc.start.offset,
  )

  return {
    type: 'template',
    content: transformed,
    attrs: block.attrs,
  }
}

const styleLoader = defineDefaultBlockLoader({
  defaultLang: 'css',
  type: 'style',
})

const scriptLoader: VueBlockLoader = async (block) => {
  if (block.type !== 'script') {
    return
  }

  const result = transpile(block.content)

  return {
    type: block.type,
    attrs: toOmit(block.attrs, ['lang', 'generic']),
    content: result,
  }
}

export const vueLoader = defineVueLoader({
  blockLoaders: {
    script: scriptLoader,
    template: templateLoader,
    style: styleLoader,
  },
})

export function cleanupBreakLine(str: string): string {
  return str.replaceAll(/(\n\n)\n+/g, '\n\n').replace(/^\s*\n|\n\s*$/g, '')
}

function toOmit<R extends Record<keyof object, unknown>, K extends keyof R>(record: R, toRemove: K[]): Omit<R, K> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !toRemove.includes(key as K))) as Omit<R, K>
}
