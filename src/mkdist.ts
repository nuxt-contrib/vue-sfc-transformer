import type { SFCBlock, SFCTemplateBlock } from 'vue/compiler-sfc'
import type { InputFile, Loader, LoaderContext, LoaderResult, OutputFile } from './types/mkdist'
import { preTranspileScriptSetup, transpileVueTemplate } from './index'

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
    let fakeScriptBlock = false

    const raw = await input.getContents()
    const sfc = parse(raw, {
      filename: input.srcPath,
      ignoreEmpty: true,
    })
    if (sfc.errors.length > 0) {
      for (const error of sfc.errors) {
        console.error(error)
      }
      return
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
    if (!sfc.descriptor.script && !sfc.descriptor.scriptSetup) {
      // push a fake script block to generate dts
      blocks.unshift({
        type: 'script',
        content: 'default {}',
        attrs: {},
        loc: {
          start: {
            offset: 0,
            line: 1,
            column: 1,
          },
          end: {
            offset: 0,
            line: 1,
            column: 1,
          },
          source: '',
        },
      })
      fakeScriptBlock = true
    }

    const results = await Promise.all(
      blocks.map(async (data) => {
        const blockLoader = blockLoaders[data.type]
        const result = await blockLoader?.(data, {
          ...context,
          rawInput: input,
          addOutput,
          requireTranspileTemplate: isTs,
        })
        if (result) {
          modified = true
        }
        return { block: result || data, offset: data.loc.start.offset }
      }),
    )

    if (!modified) {
      return
    }

    const contents = results
      .sort((a, b) => a.offset - b.offset)
      .map(({ block }) => {
        if (block.type === 'script' && fakeScriptBlock) {
          return undefined
        }

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

function defineDefaultBlockLoader(options: DefaultBlockLoaderOptions): VueBlockLoader {
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
  { requireTranspileTemplate, loadFile, rawInput },
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
    async (code) => {
      const res = await loadFile({
        getContents: () => code,
        path: `${rawInput.path}.ts`,
        srcPath: `${rawInput.srcPath}.ts`,
        extension: '.ts',
      })

      return res?.find(f => (['.js', '.mjs', '.cjs'] as Array<string | undefined>).includes(f.extension))?.contents || code
    },
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

const scriptLoader = defineDefaultBlockLoader({
  defaultLang: 'js',
  type: 'script',
  validExtensions: ['.js', '.mjs'],
})

export const vueLoader = defineVueLoader({
  blockLoaders: {
    script: scriptLoader,
    template: templateLoader,
    style: styleLoader,
  },
})

function cleanupBreakLine(str: string): string {
  return str.replaceAll(/(\n\n)\n+/g, '\n\n').replace(/^\s*\n|\n\s*$/g, '')
}
function toOmit<R extends Record<keyof object, unknown>, K extends keyof R>(record: R, toRemove: K[]): Omit<R, K> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !toRemove.includes(key as K))) as Omit<R, K>
}
