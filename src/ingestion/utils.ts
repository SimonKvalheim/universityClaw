export function toKebabCase(str: string): string {
  return str
    .toLowerCase()
    .replace(/[()[\]{}'"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
