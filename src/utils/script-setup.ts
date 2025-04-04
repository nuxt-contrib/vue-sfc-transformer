import type { ArrayExpression, CallExpression, Expression, ExpressionStatement, Identifier, Node, ObjectExpression, ObjectProperty, StringLiteral } from '@babel/types'
import type { SFCDescriptor, SFCScriptBlock, SimpleTypeResolveContext } from 'vue/compiler-sfc'

import { generate } from '@babel/generator'
import { parse } from '@babel/parser'

interface Context {
  ctx: SimpleTypeResolveContext
  utils: {
    extractRuntimeProps: typeof import('vue/compiler-sfc').extractRuntimeProps
    extractRuntimeEmits: typeof import('vue/compiler-sfc').extractRuntimeEmits
    inferRuntimeType: typeof import('vue/compiler-sfc').inferRuntimeType
    MagicString: typeof import('vue/compiler-sfc').MagicString
  }
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
    throw new Error('No script setup block found')
  }
  const context = await prepareContext(sfc as SFCDescriptor & { scriptSetup: SFCScriptBlock }, id)
  const resultBuilder = new context.utils.MagicString(sfc.scriptSetup.content)

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
  const propsStr = context.utils.extractRuntimeProps(context.ctx)
  const propsAst = parse(`${DEFINE_PROPS}(${propsStr})`, {
    sourceType: 'module',
    plugins: ['typescript'],
  })

  node.typeArguments = undefined
  node.typeParameters = undefined
  node.arguments = (
    (propsAst.program.body[0] as ExpressionStatement)
      .expression as CallExpression
  ).arguments

  return generate(node).code
}
function processDefineEmits(node: Expression, context: Context): string | undefined {
  if (!isCallOf(node, DEFINE_EMITS)) {
    return
  }

  const emitsRuntimeDecl = node.arguments[0]
  if (!node.typeParameters) {
    return
  }
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
  const emits = context.utils.extractRuntimeEmits(context.ctx)

  node.typeArguments = undefined
  node.typeParameters = undefined
  node.arguments[0] = {
    type: 'ArrayExpression',
    elements: [...emits].map(emit => ({
      type: 'StringLiteral',
      value: emit,
    })),
  }

  return generate(node).code
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

  const model = context.utils.inferRuntimeType(context.ctx, modelTypeDecl)
  if (!model || model.length === 0 || model[0] === 'Unknown') {
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

  node.typeArguments = undefined
  node.typeParameters = undefined
  node.arguments = modelNameDecl
    ? [modelNameDecl, modelCodegenDecl]
    : [modelCodegenDecl]

  return generate(node).code
}

function getDefineModelRuntimeDecl(node: CallExpression, context: Context): [StringLiteral | undefined, ObjectExpression | undefined] {
  const [arg0, arg1] = node.arguments
  if (arg0 && arg0.type === 'StringLiteral') {
    if (arg1 && arg1.type !== 'ObjectExpression') {
      context.ctx.error(
        `${DEFINE_MODEL}()'s second argument must be an object.`,
        arg1,
      )
    }

    return [arg0, arg1 as ObjectExpression]
  }

  if (arg0 && arg0.type !== 'ObjectExpression' && !(arg0.type === 'Identifier' && arg0.name === 'undefined')) {
    context.ctx.error(`Unexpected argument type for ${DEFINE_MODEL}().`, arg0)
  }

  return [undefined, arg0 as ObjectExpression | undefined]
}

async function prepareContext({ script, scriptSetup }: SFCDescriptor & { scriptSetup: SFCScriptBlock }, id: string): Promise<Context> {
  const { extractRuntimeProps, extractRuntimeEmits, inferRuntimeType, MagicString } = await import('vue/compiler-sfc')

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
    utils: {
      MagicString,
      extractRuntimeProps,
      extractRuntimeEmits,
      inferRuntimeType,
    },
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
