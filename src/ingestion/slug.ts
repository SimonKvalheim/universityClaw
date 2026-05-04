import { basename, extname } from 'node:path';
import { toKebabCase } from './utils.js';

export function slugFromFilename(filename: string): string {
  const base = basename(filename, extname(filename));
  return toKebabCase(base).replace(/^-+|-+$/g, '');
}
