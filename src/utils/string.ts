export function cleanupBreakLine(str: string): string {
  return str.replaceAll(/(\n\n)\n+/g, '\n\n').replace(/^\s*\n|\n\s*$/g, '')
}
