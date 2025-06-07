export function toOmit<R extends Record<keyof object, unknown>, K extends keyof R>(record: R, toRemove: K[]): Omit<R, K> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !toRemove.includes(key as K))) as Omit<R, K>
}
