import { createHash } from 'crypto';

/**
 * Strip only ASCII whitespace to match Python's str.strip().
 * JS .trim() also strips Unicode whitespace (U+00A0, U+2003, etc.)
 * which Python's strip() does not — causing hash divergence on
 * PDF-sourced content with non-breaking spaces.
 */
export function pythonStrip(s: string): string {
  return s.replace(/^[\t\n\r\f\v ]+|[\t\n\r\f\v ]+$/g, '');
}

/**
 * Compute a LightRAG-compatible document ID.
 * LightRAG uses: "doc-" + md5(content.strip())
 */
export function computeDocId(content: string): {
  hash: string;
  docId: string;
} {
  const stripped = pythonStrip(content);
  const hash = createHash('md5').update(stripped).digest('hex');
  return { hash, docId: `doc-${hash}` };
}
