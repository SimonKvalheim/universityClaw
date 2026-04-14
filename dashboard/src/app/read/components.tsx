'use client';

import { useRef, useEffect } from 'react';
import { getORPIndex, TokenizedWord } from './useRSVPEngine';

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function getFontSize(chunk: TokenizedWord[]): number {
  const maxLen = chunk.reduce((max, w) => Math.max(max, w.word.length), 0);
  if (maxLen > 30) return 24;
  if (maxLen > 20) return 32;
  return 44;
}

export function segmentClass(active: boolean) {
  return `px-3 py-1.5 text-sm rounded transition-colors ${
    active
      ? 'bg-blue-600 text-white'
      : 'bg-gray-800 text-gray-400 hover:text-gray-200 cursor-pointer'
  }`;
}

// ---------------------------------------------------------------------------
// Helper components
// ---------------------------------------------------------------------------

export function ORPDisplay({ chunk, fontSize }: { chunk: TokenizedWord[]; fontSize: number }) {
  if (chunk.length === 0) return null;

  // Find longest word for ORP alignment
  const longestWord = chunk.reduce((longest, w) =>
    w.word.length > longest.word.length ? w : longest
  );
  const word = longestWord.word;
  const pivot = getORPIndex(word);

  const before = word.slice(0, pivot);
  const pivotChar = word[pivot] ?? '';
  const after = word.slice(pivot + 1);

  // For multi-word chunks, join remaining words
  const otherWords = chunk
    .filter((w) => w !== longestWord)
    .map((w) => w.word)
    .join(' ');
  const displayWord = chunk.length > 1
    ? chunk.map((w) => w.word).join(' ')
    : word;

  // For multi-word chunks, build the full phrase and calculate pivot offset
  // relative to the longest word's pivot character within the phrase
  if (chunk.length > 1) {
    const phrase = chunk.map((w) => w.word).join(' ');
    // Find the character position of the pivot within the full phrase
    let charsBeforeLongest = 0;
    for (const w of chunk) {
      if (w === longestWord) break;
      charsBeforeLongest += w.word.length + 1; // +1 for space
    }
    const pivotInPhrase = charsBeforeLongest + pivot;
    const phraseShiftCh = phrase.length / 2 - pivotInPhrase - 0.5;

    return (
      <div className="relative flex items-center justify-center" style={{ fontSize, fontFamily: 'ui-monospace, monospace', minHeight: '1.5em' }}>
        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-gray-800" />
        <span style={{ transform: `translateX(${phraseShiftCh}ch)` }}>
          {chunk.map((w, i) => {
            const isLongest = w === longestWord;
            return (
              <span key={i}>
                {i > 0 && ' '}
                {isLongest ? (
                  <>
                    <span className="text-gray-300">{before}</span>
                    <span className="text-red-500 font-bold">{pivotChar}</span>
                    <span className="text-gray-300">{after}</span>
                  </>
                ) : (
                  <span className="text-gray-300">{w.word}</span>
                )}
              </span>
            );
          })}
        </span>
      </div>
    );
  }

  // Offset so the pivot character's center aligns with the center line.
  // In monospace, each char is 1ch wide. The pivot center is at (pivot + 0.5)ch
  // from the left edge. The word center is at (word.length / 2)ch.
  // Shift = (word.length / 2 - pivot - 0.5)ch to the right.
  const shiftCh = word.length / 2 - pivot - 0.5;

  return (
    <div
      className="relative flex items-center justify-center"
      style={{ fontSize, fontFamily: 'ui-monospace, monospace', minHeight: '1.5em' }}
    >
      <div className="absolute left-1/2 top-0 bottom-0 w-px bg-gray-800" />
      <span
        className="flex items-center"
        style={{ transform: `translateX(${shiftCh}ch)` }}
      >
        <span className="text-gray-300">{before}</span>
        <span className="text-red-500 font-bold">{pivotChar}</span>
        <span className="text-gray-300">{after}</span>
      </span>
    </div>
  );
}

export function CenteredDisplay({ chunk, fontSize }: { chunk: TokenizedWord[]; fontSize: number }) {
  const text = chunk.map((w) => w.word).join(' ');
  return (
    <div
      className="flex items-center justify-center text-gray-100"
      style={{ fontSize, fontFamily: 'ui-monospace, monospace', minHeight: '1.5em' }}
    >
      {text}
    </div>
  );
}

export function ContextDisplay({
  chunk,
  words,
  position,
  fontSize,
}: {
  chunk: TokenizedWord[];
  words: TokenizedWord[];
  position: number;
  fontSize: number;
}) {
  const before = words
    .slice(Math.max(0, position - 10), position)
    .map((w) => w.word)
    .join(' ');
  const after = words
    .slice(position + chunk.length, position + chunk.length + 10)
    .map((w) => w.word)
    .join(' ');

  return (
    <div className="flex flex-col items-center gap-2">
      <p className="text-gray-700 text-sm truncate max-w-full text-center">{before}</p>
      <ORPDisplay chunk={chunk} fontSize={fontSize} />
      <p className="text-gray-700 text-sm truncate max-w-full text-center">{after}</p>
    </div>
  );
}

export function SourcePanel({ text, position }: { text: string; words: TokenizedWord[]; position: number }) {
  const allWords = text.trim().split(/\s+/);
  const start = Math.max(0, position - 250);
  const end = Math.min(allWords.length, position + 250);
  const slice = allWords.slice(start, end);

  const highlightRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    highlightRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [position]);

  return (
    <div className="max-h-48 overflow-y-auto text-xs leading-relaxed text-gray-600 p-3 bg-gray-900 border border-gray-800 rounded-lg">
      {slice.map((word, i) => {
        const globalIdx = start + i;
        const isHighlighted = globalIdx === position;
        return (
          <span key={globalIdx}>
            {isHighlighted ? (
              <span
                ref={highlightRef}
                className="bg-blue-900 text-blue-200 px-0.5 rounded"
              >
                {word}
              </span>
            ) : (
              <span className="text-gray-600">{word}</span>
            )}
            {' '}
          </span>
        );
      })}
    </div>
  );
}
