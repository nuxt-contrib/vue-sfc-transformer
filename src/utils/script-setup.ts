import type { ArrayExpression, CallExpression, Expression, Identifier, Node, ObjectExpression, ObjectProperty, StringLiteral } from '@babel/types'
import type { SFCDescriptor, SFCScriptBlock, SimpleTypeResolveContext } from 'vue/compiler-sfc'

import { parse } from '@babel/parser'
import { extractRuntimeEmits, extractRuntimeProps, inferRuntimeType, MagicString } from 'vue/compiler-sfc'

interface Context {
  ctx: SimpleTypeResolveContext
}

const DEFINE_EMITS = 'defineEmits'
const DEFINE_PROPS = 'defineProps'
const WITH_DEFAULTS = 'withDefaults'
const DEFINE_MODEL = 'defineModel'

/**
 * Pre-transpile script setup block to remove type syntax and replace it with runtime declarations.
 * This function only performs minimal error checking, it means that it will preserve all errors that can be triggered at runtime
 */
export async function preTranspileScriptSetup(sfc: SFCDescriptor, id: string): Promise<SFCScriptBlock> {
  if (!sfc.scriptSetup) {
    throw new Error('[vue-sfc-transformer] No script setup block found')
  }
  const context = await prepareContext(sfc as SFCDescriptor & { scriptSetup: SFCScriptBlock }, id)
  const resultBuilder = new MagicString(sfc.scriptSetup.content)

  for (const node of context.ctx.ast) {
    if (node.type === 'ExpressionStatement') {
      const processedTypeSyntax = processDefineProps(node.expression, context)
        || processDefineEmits(node.expression, context)
        || processWithDefaults(node.expression, context)
        || processDefineModel(node.expression, context)

      if (processedTypeSyntax !== undefined) {
        resultBuilder.overwrite(node.start!, node.end!, processedTypeSyntax)
      }
    }

    if (node.type === 'VariableDeclaration' && !node.declare) {
      const total = node.declarations.length
      for (let i = 0; i < total; i += 1) {
        const decl = node.declarations[i]!
        if (!decl.init) {
          continue
        }

        const processedTypeSyntax
          = processDefineProps(decl.init, context)
            || processDefineEmits(decl.init, context)
            || processWithDefaults(decl.init, context)
            || processDefineModel(decl.init, context)

        if (processedTypeSyntax !== undefined) {
          resultBuilder.overwrite(
            decl.init.start!,
            decl.init.end!,
            processedTypeSyntax,
          )
        }
      }
    }
  }

  return {
    ...sfc.scriptSetup,
    content: resultBuilder.toString(),
  }
}

function processDefineProps(node: Expression, context: Context): string | undefined {
  if (!isCallOf(node, DEFINE_PROPS)) {
    return
  }

  const propsRuntimeDecl = node.arguments[0]
  if (!node.typeParameters) {
    return
  }
  if (propsRuntimeDecl) {
    context.ctx.error(
      `${DEFINE_PROPS}() cannot accept both type and non-type arguments `
      + `at the same time. Use one or the other.`,
      node,
    )
  }

  const propsTypeDecl = node.typeParameters.params[0]
  if (!propsTypeDecl) {
    return
  }

  context.ctx.propsTypeDecl = propsTypeDecl
  const propsStr = extractRuntimeProps(context.ctx) || '{}'

  return `${DEFINE_PROPS}(${propsStr})`
}
function processDefineEmits(node: Expression, context: Context): string | undefined {
  if (!isCallOf(node, DEFINE_EMITS)) {
    return
  }

  if (!node.typeParameters) {
    return
  }
  const emitsRuntimeDecl = node.arguments[0]
  if (emitsRuntimeDecl) {
    context.ctx.error(
      `${DEFINE_EMITS}() cannot accept both type and non-type arguments `
      + `at the same time. Use one or the other.`,
      node,
    )
  }

  const emitsTypeDecl = node.typeParameters.params[0]
  if (!emitsTypeDecl) {
    return
  }

  context.ctx.emitsTypeDecl = emitsTypeDecl
  const emits = extractRuntimeEmits(context.ctx)

  return `defineEmits([${[...emits].map(emit => `"${emit}"`).join(', ')}])`
}
function processWithDefaults(node: Expression, context: Context): string | undefined {
  if (!isCallOf(node, WITH_DEFAULTS)) {
    return
  }

  context.ctx.propsRuntimeDefaults = node.arguments[1]
  const res = processDefineProps(node.arguments[0] as Expression, context)
  if (!res) {
    context.ctx.error(
      `${WITH_DEFAULTS}' first argument must be a ${DEFINE_PROPS} call.`,
      node.arguments[0] || node,
    )
  }

  if (!context.ctx.propsTypeDecl) {
    context.ctx.error(
      `${WITH_DEFAULTS} can only be used with type-based `
      + `${DEFINE_PROPS} declaration.`,
      node,
    )
  }
  if (!context.ctx.propsRuntimeDefaults) {
    context.ctx.error(
      `The 2nd argument of ${WITH_DEFAULTS} is required.`,
      node,
    )
  }

  return res
}
function processDefineModel(node: Expression, context: Context): string | undefined {
  if (!isCallOf(node, DEFINE_MODEL)) {
    return
  }

  const [modelNameDecl, modelRuntimeDecl] = getDefineModelRuntimeDecl(
    node,
    context,
  )

  const modelTypeDecl = node.typeParameters?.params[0]
  if (!modelTypeDecl) {
    return
  }

  let model = inferRuntimeType(context.ctx, modelTypeDecl)
  let skipCheck = false
  const hasBoolean = model.includes('Boolean')
  const hasFunction = model.includes('Function')
  const hasUnknownType = model.includes('Unknown')
  if (hasUnknownType) {
    if (hasBoolean || hasFunction) {
      skipCheck = true
      model = model.filter(t => t !== 'Unknown')
    }
    else {
      model = ['null']
    }
  }
  if (!model || model.length === 0) {
    return
  }

  // { type: String } or { type: [String, Number] } if model have multiple types
  const modelCodegenTypeDecl
    = model.length === 1
      ? ({ type: 'Identifier', name: model[0]! } satisfies Identifier)
      : ({
          type: 'ArrayExpression',
          elements: model.map(
            name => ({ type: 'Identifier', name }) satisfies Identifier,
          ),
        } satisfies ArrayExpression)

  const modelCodegenDecl: ObjectExpression = {
    type: 'ObjectExpression',
    properties: [
      {
        type: 'ObjectProperty',
        key: { type: 'StringLiteral', value: 'type' },
        value: modelCodegenTypeDecl,
        computed: false,
        shorthand: false,
      } satisfies ObjectProperty,
    ],
  }
  if (modelRuntimeDecl) {
    modelCodegenDecl.properties.push({
      type: 'SpreadElement',
      argument: modelRuntimeDecl,
    })
  }

  const codegenArgs: string[] = []
  if (modelNameDecl) {
    codegenArgs.push(`"${modelNameDecl.value}"`)
  }

  const codegenType = model.length === 1 ? model[0] : `[${model.join(', ')}]`
  const codegenSkipCheck = skipCheck ? 'skipCheck: true' : ''
  const codegenExtra = modelRuntimeDecl ? `...${context.ctx.getString(modelRuntimeDecl)}` : ''
  codegenArgs.push(`{ ${[`type: ${codegenType}`, codegenSkipCheck, codegenExtra].filter(s => !!s).join(', ')} }`)

  return `${DEFINE_MODEL}(${codegenArgs.join(', ')})`
}

function getDefineModelRuntimeDecl(node: CallExpression, context: Context): [StringLiteral | undefined, ObjectExpression | undefined] {
  const [arg0, arg1] = node.arguments
  if (arg0 && arg0.type === 'StringLiteral') {
    if (arg1 && arg1.type !== 'ObjectExpression') {
      context.ctx.error(`${DEFINE_MODEL}()'s second argument must be an object.`, arg1)
    }

    return [arg0, arg1 as ObjectExpression]
  }

  if (arg0 && arg0.type !== 'ObjectExpression' && !(arg0.type === 'Identifier' && arg0.name === 'undefined')) {
    context.ctx.error(`Unexpected argument type for ${DEFINE_MODEL}().`, arg0)
  }

  return [undefined, arg0 as ObjectExpression | undefined]
}

async function prepareContext({ script, scriptSetup }: SFCDescriptor & { scriptSetup: SFCScriptBlock }, id: string): Promise<Context> {
  const helper = new Set<string>()
  const ast = parse(`${scriptSetup.content}\n${script?.content}`, {
    sourceType: 'module',
    plugins: (['tsx', 'jsx'] as Array<string | undefined>).includes(scriptSetup.lang)
      ? ['typescript', 'jsx']
      : ['typescript'],
  })

  const ctx = {
    filename: id,
    source: scriptSetup.content,
    ast: ast.program.body,
    error: (msg) => {
      throw new Error(`[vue-sfc-transformer] ${msg}`)
    },
    helper: (key) => {
      helper.add(key)
      return `_${key}`
    },
    getString: (node) => {
      return scriptSetup.content.slice(node.start!, node.end!)
    },
    propsTypeDecl: undefined,
    propsRuntimeDefaults: undefined,
    propsDestructuredBindings: Object.create(null),
    emitsTypeDecl: undefined,
    isCE: false,
    options: {},
  } satisfies SimpleTypeResolveContext

  return {
    ctx,
  }
}

function isCallOf(node: Node | undefined | undefined, test: string | ((id: string) => boolean)): node is CallExpression {
  return !!(
    node
    && node.type === 'CallExpression'
    && node.callee.type === 'Identifier'
    && (typeof test === 'string'
      ? node.callee.name === test
      : test(node.callee.name))
  )
}
