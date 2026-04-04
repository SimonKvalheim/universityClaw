import { describe, it, expect } from "vitest";
import {
  getORPIndex,
  tokenize,
  computeDuration,
  tokenizeWithDurations,
  getChunk,
  computeTimeLeft,
} from "./useRSVPEngine";

// ---------------------------------------------------------------------------
// getORPIndex
// ---------------------------------------------------------------------------

describe("getORPIndex", () => {
  it("returns 0 for single char word", () => {
    expect(getORPIndex("a")).toBe(0);
  });

  it("returns 0 for 3-char word", () => {
    expect(getORPIndex("cat")).toBe(0);
  });

  it("returns 1 for 4-char word", () => {
    expect(getORPIndex("word")).toBe(1);
  });

  it("returns 1 for 6-char word", () => {
    expect(getORPIndex("bridge")).toBe(1);
  });

  it("returns 2 for 7-char word", () => {
    expect(getORPIndex("capable")).toBe(2);
  });

  it("returns 2 for 9-char word", () => {
    expect(getORPIndex("beautiful")).toBe(2);
  });

  it("returns 3 for 10-char word", () => {
    expect(getORPIndex("absolutely")).toBe(3);
  });

  it("returns 3 for long word", () => {
    expect(getORPIndex("understanding")).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------

describe("tokenize", () => {
  it("returns empty array for empty string", () => {
    expect(tokenize("")).toEqual([]);
  });

  it("tokenizes a simple sentence into words with correct indices", () => {
    const result = tokenize("Hello world foo");
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ word: "Hello", index: 0, paragraphBreak: false });
    expect(result[1]).toEqual({ word: "world", index: 1, paragraphBreak: false });
    expect(result[2]).toEqual({ word: "foo", index: 2, paragraphBreak: false });
  });

  it("marks the first word of the second paragraph with paragraphBreak=true", () => {
    const result = tokenize("First paragraph.\n\nSecond paragraph.");
    expect(result).toHaveLength(4);
    expect(result[0].paragraphBreak).toBe(false);
    expect(result[1].paragraphBreak).toBe(false);
    expect(result[2].paragraphBreak).toBe(true);
    expect(result[2].word).toBe("Second");
    expect(result[3].paragraphBreak).toBe(false);
  });

  it("treats multiple blank lines as a single paragraph break", () => {
    const result = tokenize("One.\n\n\n\nTwo.");
    expect(result).toHaveLength(2);
    expect(result[1].paragraphBreak).toBe(true);
  });

  it("does not set paragraphBreak on the very first word", () => {
    const result = tokenize("Start here.");
    expect(result[0].paragraphBreak).toBe(false);
  });

  it("trims leading and trailing whitespace", () => {
    const result = tokenize("  hello world  ");
    expect(result).toHaveLength(2);
    expect(result[0].word).toBe("hello");
    expect(result[1].word).toBe("world");
  });

  it("assigns consecutive global indices across paragraphs", () => {
    const result = tokenize("a b\n\nc d");
    expect(result.map((w) => w.index)).toEqual([0, 1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// computeDuration — use baseMs=100 for easy arithmetic
// ---------------------------------------------------------------------------

function makeWord(
  word: string,
  opts: { paragraphBreak?: boolean } = {}
): Omit<import("./useRSVPEngine").TokenizedWord, "duration"> {
  return { word, index: 0, paragraphBreak: opts.paragraphBreak ?? false };
}

describe("computeDuration", () => {
  it("returns baseMs for a plain word (1.0x)", () => {
    expect(computeDuration(makeWord("hello"), 100)).toBe(100);
  });

  it("applies 2.0x for sentence-ending period", () => {
    expect(computeDuration(makeWord("end."), 100)).toBe(200);
  });

  it("applies 2.0x for sentence-ending exclamation mark", () => {
    expect(computeDuration(makeWord("wow!"), 100)).toBe(200);
  });

  it("applies 2.0x for sentence-ending question mark", () => {
    expect(computeDuration(makeWord("really?"), 100)).toBe(200);
  });

  it("applies 1.5x for clause comma", () => {
    expect(computeDuration(makeWord("however,"), 100)).toBe(150);
  });

  it("applies 1.5x for clause semicolon", () => {
    expect(computeDuration(makeWord("here;"), 100)).toBe(150);
  });

  it("applies 1.5x for clause colon", () => {
    expect(computeDuration(makeWord("note:"), 100)).toBe(150);
  });

  it("applies 1.3x for long word (>8 chars, stripped)", () => {
    // "abcdefghi" = 9 chars — stripped length = 9 > 8
    expect(computeDuration(makeWord("abcdefghi"), 100)).toBe(130);
  });

  it("stacks 2.0x * 1.3x = 2.6x for long word ending sentence", () => {
    // "abcdefghi." — stripped = "abcdefghi" (9 chars), sentence-ending
    expect(computeDuration(makeWord("abcdefghi."), 100)).toBe(260);
  });

  it("applies 2.5x for paragraph break word", () => {
    expect(computeDuration(makeWord("New", { paragraphBreak: true }), 100)).toBe(250);
  });

  it("applies 1.5x for word containing numbers", () => {
    expect(computeDuration(makeWord("chapter2"), 100)).toBe(150);
  });

  it("caps combined multiplier at 3.0x", () => {
    // paragraphBreak(2.5) * sentenceEnd(2.0) = 5.0 → capped at 3.0
    expect(computeDuration(makeWord("end.", { paragraphBreak: true }), 100)).toBe(300);
  });

  it("caps even when three conditions stack above 3.0x", () => {
    // sentenceEnd(2.0) * long(1.3) * numbers(1.5) = 3.9 → capped at 3.0
    // "abcdefghi2." — stripped = "abcdefghi2" (10 chars), sentence-ending, has digit
    expect(computeDuration(makeWord("abcdefghi2."), 100)).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// tokenizeWithDurations
// ---------------------------------------------------------------------------

describe("tokenizeWithDurations", () => {
  it("returns words with duration field attached", () => {
    const words = tokenizeWithDurations("Hello world", 600);
    // baseMs = (60/600)*1000 = 100ms
    expect(words).toHaveLength(2);
    expect(words[0].duration).toBe(100);
    expect(words[1].duration).toBe(100);
  });

  it("propagates paragraph breaks and applies correct duration multiplier", () => {
    const words = tokenizeWithDurations("Para one.\n\nPara two.", 600);
    // baseMs=100; "one." ends sentence → 200ms; "Para" in second para → 250ms
    const paraBreakWord = words.find((w) => w.paragraphBreak);
    expect(paraBreakWord).toBeDefined();
    expect(paraBreakWord!.duration).toBe(250);
  });
});

// ---------------------------------------------------------------------------
// getChunk
// ---------------------------------------------------------------------------

describe("getChunk", () => {
  const makeWords = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      tokenizeWithDurations(`word${i}`, 600)[0]
    );

  it("returns a single word when chunkSize=1", () => {
    const words = tokenizeWithDurations("alpha beta gamma", 600);
    const chunk = getChunk(words, 1, 1);
    expect(chunk).toHaveLength(1);
    expect(chunk[0].word).toBe("beta");
  });

  it("returns fewer words than chunkSize when near the end", () => {
    const words = tokenizeWithDurations("a b c", 600);
    // position=2, chunkSize=3 → only 1 word remains
    const chunk = getChunk(words, 2, 3);
    expect(chunk).toHaveLength(1);
    expect(chunk[0].word).toBe("c");
  });

  it("returns empty array when position equals length", () => {
    const words = tokenizeWithDurations("a b", 600);
    expect(getChunk(words, 2, 1)).toEqual([]);
  });

  it("returns chunk of 3 from middle position", () => {
    const words = tokenizeWithDurations("a b c d e", 600);
    const chunk = getChunk(words, 1, 3);
    expect(chunk).toHaveLength(3);
    expect(chunk.map((w) => w.word)).toEqual(["b", "c", "d"]);
  });
});

// ---------------------------------------------------------------------------
// computeTimeLeft
// ---------------------------------------------------------------------------

describe("computeTimeLeft", () => {
  it("returns total duration of all words in seconds", () => {
    // 3 words × 100ms = 300ms = 0.3s at 600wpm
    const words = tokenizeWithDurations("a b c", 600);
    expect(computeTimeLeft(words, 0)).toBeCloseTo(0.3);
  });

  it("returns partial sum from middle position", () => {
    // words: a(100ms), b(100ms), c(100ms) — from position 1 → b+c = 200ms = 0.2s
    const words = tokenizeWithDurations("a b c", 600);
    expect(computeTimeLeft(words, 1)).toBeCloseTo(0.2);
  });

  it("returns 0 when position equals total word count", () => {
    const words = tokenizeWithDurations("a b c", 600);
    expect(computeTimeLeft(words, 3)).toBe(0);
  });

  it("accounts for timing multipliers in the sum", () => {
    // "end." at 600wpm → 200ms; "plain" → 100ms; from pos 0 → 300ms = 0.3s
    const words = tokenizeWithDurations("end. plain", 600);
    expect(computeTimeLeft(words, 0)).toBeCloseTo(0.3);
  });
});
