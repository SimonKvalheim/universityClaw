/**
 * Generate a book ID by hashing the first 4KB of file content.
 */
export async function generateBookId(buffer: ArrayBuffer): Promise<string> {
  const slice = buffer.slice(0, 4096);
  const hash = await crypto.subtle.digest('SHA-256', slice);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Extract the sentence surrounding the word at `wordIndex`.
 * Scans backward and forward for sentence-ending punctuation (. ! ?).
 * Caps output at 200 characters, truncating from the left with "...".
 */
export function extractCurrentSentence(words: string[], wordIndex: number): string {
  if (words.length === 0) return '';

  const idx = Math.max(0, Math.min(wordIndex, words.length - 1));

  // Scan backward for sentence boundary
  let start = 0;
  for (let i = idx - 1; i >= 0; i--) {
    if (/[.!?]$/.test(words[i])) {
      start = i + 1;
      break;
    }
  }

  // Scan forward for sentence boundary
  let end = words.length - 1;
  for (let i = idx; i < words.length; i++) {
    if (/[.!?]$/.test(words[i])) {
      end = i;
      break;
    }
  }

  const sentence = words.slice(start, end + 1).join(' ');

  if (sentence.length <= 200) return sentence;

  return '...' + sentence.slice(-200);
}
