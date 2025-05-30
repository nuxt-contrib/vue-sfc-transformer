import type { AttributeNode, DirectiveNode, ExpressionNode, ParentNode, RootNode, SourceLocation, TemplateChildNode, TextNode } from '@vue/compiler-dom'
import { isFnExpressionBrowser as isFnExpression, isMemberExpressionBrowser as isMemberExpression } from '@vue/compiler-core'
import { transpile } from 'oxidase'

// copy from `@vue/compiler-dom`
enum NodeTypes {
  ROOT,
  ELEMENT,
  TEXT,
  COMMENT,
  SIMPLE_EXPRESSION,
  INTERPOLATION,
  ATTRIBUTE,
  DIRECTIVE,

  // containers
  COMPOUND_EXPRESSION,
  IF,
  IF_BRANCH,
  FOR,
  TEXT_CALL,

  // codegen
  VNODE_CALL,
  JS_CALL_EXPRESSION,
  JS_OBJECT_EXPRESSION,
  JS_PROPERTY,
  JS_ARRAY_EXPRESSION,
  JS_FUNCTION_EXPRESSION,
  JS_CONDITIONAL_EXPRESSION,
  JS_CACHE_EXPRESSION,

  // ssr codegen
  JS_BLOCK_STATEMENT,
  JS_TEMPLATE_LITERAL,
  JS_IF_STATEMENT,
  JS_ASSIGNMENT_EXPRESSION,
  JS_SEQUENCE_EXPRESSION,
  JS_RETURN_STATEMENT,
}

interface Expression {
  track: VueTemplateNode[]
  loc: SourceLocation
  src: string
  replacement?: string
}

type VueTemplateNode =
  | ParentNode
  | ExpressionNode
  | TemplateChildNode
  | AttributeNode
  | DirectiveNode

function handleNode(
  node: VueTemplateNode | undefined,
  addExpression: (...expressions: Expression[]) => void,
  track: VueTemplateNode[],
) {
  if (!node) {
    return
  }

  const currentTrack = [...track, node]

  const search = (
    node?: ExpressionNode | TemplateChildNode | AttributeNode
      | DirectiveNode | TextNode,
  ) => handleNode(node, addExpression, currentTrack)

  switch (node.type) {
    case NodeTypes.ROOT: {
      for (const child of node.children) {
        search(child)
      }
      return
    }
    case NodeTypes.ELEMENT: {
      const nodes = [...node.children, ...node.props]
      for (const child of nodes) {
        search(child)
      }
      return
    }
    case NodeTypes.TEXT: {
      return
    }
    case NodeTypes.COMMENT: {
      return
    }
    case NodeTypes.SIMPLE_EXPRESSION: {
      if (node.ast === null || node.ast === false) {
        return
      }
      addExpression({ loc: node.loc, src: node.content, track: currentTrack })
      return
    }
    case NodeTypes.INTERPOLATION: {
      search(node.content)
      return
    }
    case NodeTypes.ATTRIBUTE: {
      search(node.value)
      return
    }
    case NodeTypes.DIRECTIVE: {
      const nodes = [
        ...node.forParseResult
          ? [
              node.forParseResult?.source,
              node.forParseResult?.value,
              node.forParseResult?.key,
              node.forParseResult?.index,
            ]
          : [node.exp],
        // node.arg,
        ...node.modifiers,
      ].filter(item => !!item)
      for (const child of nodes) {
        search(child)
      }
      return
    }
    case NodeTypes.COMPOUND_EXPRESSION: {
      if (!node.ast) {
        return
      }

      addExpression({ loc: node.loc, src: node.loc.source, track: currentTrack })
      return
    }
    // case NodeTypes.IF:
    // case NodeTypes.FOR:
    // case NodeTypes.TEXT_CALL:
    default: {
      throw new Error(`Unexpected node type: ${node.type}`)
    }
  }
}

export async function transpileVueTemplate(
  content: string,
  root: RootNode,
  offset = 0,
): Promise<string> {
  const { MagicString } = await import('vue/compiler-sfc')
  const expressions: Expression[] = []

  handleNode(root, (...items) => expressions.push(...items), [])

  if (expressions.length === 0) {
    return content
  }

  const s = new MagicString(content)

  const transformMap = transformJsSnippets(expressions, code => transpile(code))
  for (const item of expressions) {
    item.replacement = transformMap.get(item) ?? item.src
  }

  for (const item of expressions) {
    if (item.replacement && item.replacement !== item.src) {
      s.overwrite(
        item.loc.start.offset - offset,
        item.loc.end.offset - offset,
        item.replacement,
      )
    }
  }

  return s.toString()
}

export function replaceQuote(code: string, target: string, replace: string): string {
  let res = code

  if (res.includes(target)) {
    /**
     * Due to the way Vue parses templates,
     * the symbol of target would never appear in the code.
     * We just need to replace the symbol of target.
     *
     * But for replace symbol exist in code, we need to escape it,
     * because esbuild have removed the escape character.
     */
    res = res.replaceAll(replace, `\\${replace}`)
    res = res.replaceAll(target, replace)
  }

  return res
}

interface SnippetHandler {
  key: (node: Expression) => string | null
  prepare: (node: Expression, id: number) => string
  parse: (code: string, id: number) => string | undefined
  standalone: boolean
}

const defaultSnippetHandler: SnippetHandler = {
  key: node => `default$:${node.src}`,
  prepare: (node, id) => `wrapper_${id}(${node.src});`,
  parse: (code) => {
    const wrapperRegex = /^(wrapper_\d+)\(([\s\S]*?)\);$/

    const [_, wrapperName, res] = code.match(wrapperRegex) ?? []
    if (!wrapperName || !res) {
      return undefined
    }

    return res
  },
  standalone: false,
}

const multipleStatementsSnippetHandler: SnippetHandler = {
  key: (node) => {
    const key = `multipleStatements$:${node.src}`
    const secondLastTrack = node.track.at(-2)
    const lastTrack = node.track.at(-1)

    if (
      lastTrack?.type === NodeTypes.SIMPLE_EXPRESSION
      && secondLastTrack?.type === NodeTypes.DIRECTIVE
      && secondLastTrack.name === 'on'
    ) {
      const isMemberExp = isMemberExpression(lastTrack)
      const isInlineStatement = !(isMemberExp || isFnExpression(lastTrack))

      const hasMultipleStatements = node.src.includes(';')

      if ((isInlineStatement || isMemberExp) && hasMultipleStatements) {
        return key
      }
    }

    return null
  },
  prepare: (node, id) => `wrapper_${id}(() => {${node.src}});`,
  parse: (code) => {
    const wrapperRegex = /^(wrapper_\d+)\(\(\) => \{([\s\S]*?)\}\);$/

    const [_, wrapperName, res] = code.trim().match(wrapperRegex) ?? []
    if (!wrapperName || !res) {
      return undefined
    }

    return res.trim().replace(/;$/, '')
  },
  standalone: false,
}

const destructureSnippetHandler: SnippetHandler = {
  key: (node) => {
    const key = `destructure$:${node.src}`
    const lastTrack = node.track.at(-1)
    const secondLastTrack = node.track.at(-2)

    // v-slot:xxx="{ name }"
    if (secondLastTrack?.type === NodeTypes.DIRECTIVE && secondLastTrack.name === 'slot') {
      return key
    }

    // v-for="({ name }, key,   index) of items"
    //         ^this     ^this  ^this     ^not this
    if (
      secondLastTrack?.type === NodeTypes.DIRECTIVE
      && secondLastTrack.name === 'for'
      && secondLastTrack?.forParseResult
      && lastTrack !== secondLastTrack.forParseResult.source
    ) {
      return key
    }
    return null
  },
  prepare: (node, id) => `const ${node.src} = wrapper_${id}();`,
  parse: (code) => {
    const regex = /^const([\s\S]*?)=\s+wrapper_\d+\(\);$/
    const [_, res] = code.match(regex) ?? []
    if (!res) {
      return undefined
    }
    return res.trim()
  },
  standalone: true,
}

const snippetHandlers = [destructureSnippetHandler, multipleStatementsSnippetHandler, defaultSnippetHandler]
function getKey(expression: Expression) {
  for (const handler of snippetHandlers) {
    const key = handler.key(expression)
    if (key) {
      return { key, handler }
    }
  }
}

function generateSnippetSplitter() {
  const identify = Math.random().toString(36).substring(2, 15)
  return `\nsplitter(${JSON.stringify(identify)});\n`
}

function transformJsSnippets(expressions: Expression[], transform: (code: string) => string): WeakMap<Expression, string> {
  const transformMap = new Map<string, { id: number, nodes: [Expression, ...Expression[]], handler: SnippetHandler }>()

  let id = 0
  for (const expression of expressions) {
    const res = getKey(expression)
    if (!res) {
      continue
    }
    if (transformMap.has(res.key)) {
      const item = transformMap.get(res.key)!
      item.nodes.push(expression)
      continue
    }

    transformMap.set(res.key, { id, nodes: [expression], handler: res.handler })
    id += 1
  }

  const resultMap = new Map<Expression, string>()

  const orders = Array.from(transformMap.values())
  const batch = orders.filter(({ handler }) => !handler.standalone)
  const standalone = orders.filter(({ handler }) => handler.standalone)

  try {
    // transform all snippets in a single file
    const batchInputSplitter = generateSnippetSplitter()
    const batchInput = batch
      .map(({ nodes, handler }) => handler.prepare(nodes[0], id))
      .join(batchInputSplitter)

    const batchOutput = transform(batchInput)
    const lines = batchOutput.split(batchInputSplitter).map(l => l.trim()).filter(l => !!l)

    if (lines.length !== batch.length) {
      throw new Error('[vue-sfc-transform] Syntax Error')
    }

    for (let i = 0; i < batch.length; i++) {
      const line = lines[i]!
      const { id, handler, nodes } = batch[i]!

      const res = handler.parse(line, id)
      if (!res) {
        continue
      }

      for (const node of nodes) {
        resultMap.set(node, res)
      }
    }

    // transform standalone snippets
    standalone.forEach(({ id, handler, nodes }) => {
      const prepared = handler.prepare(nodes[0], id)
      const line = transform(prepared)

      const res = handler.parse(line.trim(), id)
      if (!res) {
        return
      }

      for (const node of nodes) {
        resultMap.set(node, res)
      }
    })
  }
  catch (error) {
    throw new Error('[vue-sfc-transform] Error parsing TypeScript expression in template', { cause: error })
  }

  return resultMap
}
