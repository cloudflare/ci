export function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}
