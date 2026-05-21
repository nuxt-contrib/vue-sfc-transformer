import { readFileSync } from 'node:fs'

import ts from 'typescript'

// Read and parse a tsconfig.json into a raw JSON object. Returns `{}` when no
// path is provided. `@vue/language-core`'s `createParsedCommandLineByJson`
// takes JSON-already (not a path), so anything that wants tsconfig-derived
// options must read the file first.
export function readTsconfigJson(tsconfig: string | undefined): Record<string, unknown> {
  if (!tsconfig) {
    return {}
  }
  let raw: string
  try {
    raw = readFileSync(tsconfig, 'utf8')
  }
  catch (cause) {
    throw new Error(`[vue-sfc-transformer] could not read tsconfig at ${tsconfig}`, { cause })
  }
  const { config, error } = ts.parseConfigFileTextToJson(tsconfig, raw)
  if (error) {
    throw new Error(`[vue-sfc-transformer] could not parse tsconfig at ${tsconfig}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`)
  }
  return (config ?? {}) as Record<string, unknown>
}
