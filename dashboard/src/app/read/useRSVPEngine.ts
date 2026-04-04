"use client";

import { useState, useEffect, useRef, useCallback } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenizedWord {
  word: string;
  index: number;
  paragraphBreak: boolean;
  duration: number; // ms
}

export interface RSVPEngineOptions {
  text: string;
  wpm: number;
  chunkSize: 1 | 2 | 3;
}

export interface RSVPEngineState {
  words: TokenizedWord[];
  position: number;
  isPlaying: boolean;
  progress: number; // 0-1
  currentChunk: TokenizedWord[];
  totalWords: number;
  estimatedTimeLeft: number; // seconds
  play: () => void;
  pause: () => void;
  seek: (deltaSeconds: number) => void;
  restart: () => void;
  jumpTo: (position: number) => void;
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Calculate the Optimal Recognition Point index for a word.
 * Used by display layers to highlight the pivot character.
 */
export function getORPIndex(word: string): number {
  const len = word.length;
  if (len <= 3) return 0;
  if (len <= 6) return 1;
  if (len <= 9) return 2;
  return 3;
}

/**
 * Tokenize text into words with paragraph-break flags.
 * Paragraph breaks are detected by blank lines (two or more consecutive newlines).
 */
export function tokenize(
  text: string
): Omit<TokenizedWord, "duration">[] {
  // Split into paragraphs by one or more blank lines
  const paragraphs = text.split(/\n{2,}/);

  const result: Omit<TokenizedWord, "duration">[] = [];
  let globalIndex = 0;
  let firstWord = true;

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    // Split paragraph into words by whitespace
    const rawWords = trimmed.split(/\s+/).filter((w) => w.length > 0);

    for (let i = 0; i < rawWords.length; i++) {
      const isFirstInParagraph = i === 0 && !firstWord;
      result.push({
        word: rawWords[i],
        index: globalIndex++,
        paragraphBreak: isFirstInParagraph,
      });
    }

    if (rawWords.length > 0) firstWord = false;
  }

  return result;
}

/**
 * Compute the display duration for a single word given a base ms value.
 * Multipliers are multiplicative and capped at 3.0x.
 */
export function computeDuration(
  word: Omit<TokenizedWord, "duration">,
  baseMs: number
): number {
  let multiplier = 1.0;

  const text = word.word;

  // Strip punctuation for length check
  const stripped = text.replace(/[^a-zA-Z0-9]/g, "");

  // Sentence-ending punctuation
  const sentenceEnd = /[.!?]$/.test(text);
  if (sentenceEnd) {
    multiplier *= 2.0;
  } else if (/[,;:]$/.test(text)) {
    // Clause punctuation — only if not sentence-ending
    multiplier *= 1.5;
  }

  // Long word
  if (stripped.length > 8) {
    multiplier *= 1.3;
  }

  // Paragraph break
  if (word.paragraphBreak) {
    multiplier *= 2.5;
  }

  // Contains numbers
  if (/\d/.test(text)) {
    multiplier *= 1.5;
  }

  // Cap at 3.0x
  multiplier = Math.min(multiplier, 3.0);

  return Math.round(baseMs * multiplier);
}

/**
 * Full pipeline: tokenize and attach durations.
 */
export function tokenizeWithDurations(
  text: string,
  wpm: number
): TokenizedWord[] {
  const baseMs = (60 / wpm) * 1000;
  const rawWords = tokenize(text);
  return rawWords.map((w) => ({
    ...w,
    duration: computeDuration(w, baseMs),
  }));
}

/**
 * Return the chunk of words starting at position.
 */
export function getChunk(
  words: TokenizedWord[],
  position: number,
  chunkSize: number
): TokenizedWord[] {
  return words.slice(position, position + chunkSize);
}

/**
 * Sum remaining word durations and return total in seconds.
 */
export function computeTimeLeft(
  words: TokenizedWord[],
  position: number
): number {
  const remaining = words.slice(position);
  const totalMs = remaining.reduce((sum, w) => sum + w.duration, 0);
  return totalMs / 1000;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useRSVPEngine(options: RSVPEngineOptions): RSVPEngineState {
  const { text, wpm, chunkSize } = options;

  const [words, setWords] = useState<TokenizedWord[]>(() =>
    tokenizeWithDurations(text, wpm)
  );
  const [position, setPosition] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  // Refs to avoid stale closures in setTimeout callbacks
  const positionRef = useRef(position);
  const wordsRef = useRef(words);
  const isPlayingRef = useRef(isPlaying);
  const chunkSizeRef = useRef(chunkSize);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep refs in sync with state
  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  useEffect(() => {
    wordsRef.current = words;
  }, [words]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    chunkSizeRef.current = chunkSize;
  }, [chunkSize]);

  // Re-tokenize when text changes — reset position
  useEffect(() => {
    const newWords = tokenizeWithDurations(text, wpm);
    setWords(newWords);
    setPosition(0);
    setIsPlaying(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  // Re-tokenize when WPM changes — keep position (live speed adjustment)
  useEffect(() => {
    setWords(tokenizeWithDurations(text, wpm));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wpm]);

  // Stable pause — only uses refs and clearTimeout
  const pause = useCallback(() => {
    setIsPlaying(false);
    isPlayingRef.current = false;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // scheduleNext is stable (empty deps) and uses only refs
  const scheduleNext = useCallback(() => {
    const currentPos = positionRef.current;
    const currentWords = wordsRef.current;
    const size = chunkSizeRef.current;

    if (currentPos >= currentWords.length) {
      // Reached end — stop playback
      setIsPlaying(false);
      isPlayingRef.current = false;
      return;
    }

    const chunk = getChunk(currentWords, currentPos, size);
    // Sum durations so WPM stays consistent regardless of chunk size.
    // Showing 2 words means showing them for 2x as long, not reading 2x faster.
    const duration = chunk.reduce((sum, w) => sum + w.duration, 0);

    timerRef.current = setTimeout(() => {
      if (!isPlayingRef.current) return;

      const nextPos = Math.min(currentPos + size, currentWords.length);
      positionRef.current = nextPos;
      setPosition(nextPos);

      if (nextPos >= currentWords.length) {
        setIsPlaying(false);
        isPlayingRef.current = false;
        return;
      }

      scheduleNext();
    }, duration);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Visibility change: pause on background, do NOT auto-resume
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        pause();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [pause]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  const play = useCallback(() => {
    if (isPlayingRef.current) return;
    setIsPlaying(true);
    isPlayingRef.current = true;
    scheduleNext();
  }, [scheduleNext]);

  const seek = useCallback(
    (deltaSeconds: number) => {
      const wordDelta = Math.round((wpm / 60) * Math.abs(deltaSeconds));
      const currentPos = positionRef.current;
      const totalLen = wordsRef.current.length;

      const newPos =
        deltaSeconds >= 0
          ? Math.min(currentPos + wordDelta, totalLen - 1)
          : Math.max(currentPos - wordDelta, 0);

      positionRef.current = newPos;
      setPosition(newPos);

      if (isPlayingRef.current) {
        if (timerRef.current !== null) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        scheduleNext();
      }
    },
    [wpm, scheduleNext]
  );

  const restart = useCallback(() => {
    pause();
    positionRef.current = 0;
    setPosition(0);
  }, [pause]);

  const jumpTo = useCallback(
    (pos: number) => {
      const totalLen = wordsRef.current.length;
      const clamped = Math.max(0, Math.min(pos, totalLen - 1));
      positionRef.current = clamped;
      setPosition(clamped);

      if (isPlayingRef.current) {
        if (timerRef.current !== null) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        scheduleNext();
      }
    },
    [scheduleNext]
  );

  // Computed values
  const totalWords = words.length;
  const progress = totalWords > 0 ? position / totalWords : 0;
  const currentChunk = getChunk(words, position, chunkSize);
  const estimatedTimeLeft = computeTimeLeft(words, position);

  return {
    words,
    position,
    isPlaying,
    progress,
    currentChunk,
    totalWords,
    estimatedTimeLeft,
    play,
    pause,
    seek,
    restart,
    jumpTo,
  };
}
