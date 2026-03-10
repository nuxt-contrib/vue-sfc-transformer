const MULTIPLE_NEW_LINES_REGEX = /(\n\n)\n+/g
const LEADING_TRAILING_NEW_LINES_REGEX = /^\s*\n|\n\s*$/g

export function cleanupBreakLine(str: string): string {
  return str.replaceAll(MULTIPLE_NEW_LINES_REGEX, '\n\n').replace(LEADING_TRAILING_NEW_LINES_REGEX, '')
}
