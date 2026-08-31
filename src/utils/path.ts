import { isAbsolute as nodeIsAbsolute, join as nodeJoin, normalize as nodeNormalize, relative as nodeRelative, resolve as nodeResolve } from 'node:path'

// Paths are compared against bundler module ids and used as virtual filesystem
// keys, both of which use forward slashes on every platform.
function toSlashes(path: string): string {
  return path.replace(/\\/g, '/')
}

export function normalize(path: string): string {
  return toSlashes(nodeNormalize(path))
}

export function join(...segments: string[]): string {
  return toSlashes(nodeJoin(...segments))
}

export function resolve(...segments: string[]): string {
  return toSlashes(nodeResolve(...segments))
}

export function relative(from: string, to: string): string {
  return toSlashes(nodeRelative(from, to))
}

export function isAbsolute(path: string): boolean {
  return nodeIsAbsolute(path) || path.startsWith('/')
}
