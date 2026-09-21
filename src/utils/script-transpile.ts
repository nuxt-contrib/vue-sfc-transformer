import type { UnsupportedSyntax } from 'petrea'
import { transpileSync } from 'petrea'

const MAX_SNIPPET_LENGTH = 80

/**
 * Strips the TypeScript types from an SFC script block, blanking them in
 * place. Like the template expressions, imports must survive untouched: a
 * type-only import referenced from the template is still a runtime import in
 * the output SFC.
 */
export function transpileScriptBlock(code: string, lang: 'ts' | 'tsx', filename: string): string {
  const unsupported: UnsupportedSyntax[] = []
  const output = transpileSync(code, {
    lang,
    onError: node => unsupported.push(node),
  })

  // petrea can only erase type-only syntax; constructs with runtime semantics
  // stay verbatim. The transpiled block loses its `lang="ts"`, so they would
  // ship as invalid JS — surface them as build errors instead.
  if (unsupported.length > 0) {
    const details = unsupported.map(node => formatUnsupported(code, node)).join('\n')
    throw new Error(
      `[vue-sfc-transformer] ${filename} uses TypeScript with runtime semantics that cannot be erased; lower it to plain syntax first:\n${details}`,
    )
  }

  return output
}

function formatUnsupported(code: string, node: UnsupportedSyntax): string {
  const lineStart = code.lastIndexOf('\n', node.start - 1) + 1
  const line = (code.slice(0, lineStart).match(/\n/g) ?? []).length + 1
  const column = node.start - lineStart + 1
  let snippet = code.slice(node.start, node.end).replace(/\s+/g, ' ').trim()
  if (snippet.length > MAX_SNIPPET_LENGTH) {
    snippet = `${snippet.slice(0, MAX_SNIPPET_LENGTH)}...`
  }
  return `- ${node.type} at ${line}:${column}: ${snippet}`
}
