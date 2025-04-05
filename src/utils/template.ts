import type { AttributeNode, DirectiveNode, ExpressionNode, ParentNode, RootNode, SourceLocation, TemplateChildNode, TextNode } from '@vue/compiler-dom'

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
  loc: SourceLocation
  src: string
  replacement?: string
}

function handleNode(
  node:
    | ParentNode
    | ExpressionNode
    | TemplateChildNode
    | AttributeNode
    | DirectiveNode
    | undefined,
  addExpression: (...expressions: Expression[]) => void,
) {
  if (!node) {
    return
  }

  const search = (node?: ExpressionNode | TemplateChildNode | AttributeNode | DirectiveNode | TextNode) => handleNode(node, addExpression)

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
      addExpression({ loc: node.loc, src: node.content })
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
        node.exp,
        // node.arg,
        // node.forParseResult?.source,
        // node.forParseResult?.value,
        // node.forParseResult?.key,
        // node.forParseResult?.index,
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

      addExpression({ loc: node.loc, src: node.loc.source })
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

export async function transpileVueTemplate(content: string, root: RootNode, offset = 0, transform: (code: string) => Promise<string>): Promise<string> {
  const { MagicString } = await import('vue/compiler-sfc')
  const expressions: Expression[] = []

  const s = new MagicString(content)

  handleNode(root, (...items) => expressions.push(...items))
  const transformMap = await transformJsSnippets(expressions.map(e => e.src), transform)
  for (const item of expressions) {
    item.replacement = transformMap.get(item.src) ?? item.src

    const surrounding = getSurrounding(
      content,
      item.loc.start.offset - offset,
      item.loc.end.offset - offset,
    )
    if (surrounding) {
      const replace = surrounding.code === `"` ? `'` : `"`
      item.replacement = replaceQuote(
        item.replacement,
        surrounding.code,
        replace,
      )
    }
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

function replaceQuote(code: string, target: string, replace: string): string {
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

function getSurrounding(code: string, start: number, end: number) {
  const empty = new Set<string | undefined>([' ', '\n', '\r', '\t'])
  let startIndex = start - 1
  let endIndex = end

  while (startIndex > 0 && empty.has(code.at(startIndex))) {
    startIndex--
  }

  while (endIndex < code.length && empty.has(code.at(endIndex))) {
    endIndex++
  }

  const prev = startIndex >= 0 ? code.at(startIndex) : ''
  const next = endIndex < code.length ? code.at(endIndex) : ''

  return prev && next && prev === next
    ? { code: prev, prevAt: startIndex, nextAt: endIndex }
    : undefined
}

async function transformJsSnippets(codes: string[], transform: (code: string) => Promise<string>): Promise<Map<string, string>> {
  const keyMap = new Map<string, string>()
  const resMap = new Map<string, string>()

  for (const code of codes) {
    keyMap.set(`wrapper_${keyMap.size}`, code)
  }

  // transform all snippets in a single file
  const batchInputSplitter = `\nsplitter(${Math.random()});\n`
  const batchInput = Array.from(keyMap.entries()).map(([wrapperName, raw]) => `${wrapperName}(${raw});`).join(batchInputSplitter)

  try {
    const batchOutput = await transform(batchInput)

    const lines = batchOutput.trim().split(batchInputSplitter)
    const wrapperRegex = /^(wrapper_\d+)\(([\s\S]*?)\);$/
    for (const line of lines) {
      const [_, wrapperName, res] = line.match(wrapperRegex) ?? []
      if (!wrapperName || !res) {
        continue
      }

      const raw = keyMap.get(wrapperName)
      if (raw) {
        resMap.set(raw, res)
      }
    }

    return resMap
  }
  catch (error) {
    throw new Error('[vue-sfc-transform] Error parsing TypeScript expression in template', { cause: error })
  }
}
