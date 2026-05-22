export function escapeSfcAttrValue(value: string): string {
  // Vue decodes HTML character references while parsing SFC attributes into
  // descriptor attrs, so escape `&` first to preserve literal references like
  // `&quot;` across a serialize/parse round-trip.
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
}
