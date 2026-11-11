export { createFileSystemDtsCache, type DtsCache } from './dts/cache'
export {
  type DeclarationDiagnostic,
  type DeclarationDiagnosticCategory,
  type DeclarationDiagnosticKind,
  isDeclarationEmitDiagnostic,
} from './dts/diagnostics'
export {
  emitVueDeclarations,
  type EmitVueDeclarationsOptions,
  type EmitVueDeclarationsResult,
  type VueDeclarationSource,
} from './dts/emit'
export { type Transform, transformVueSfc, type TransformVueSfcOptions, type TransformVueSfcResult } from './transform'
