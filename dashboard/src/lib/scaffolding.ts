/**
 * Compute recommended scaffolding level for a concept based on
 * rolling success rate (last 10 attempts).
 *
 * Scaffolding levels:
 *   0: No hints (prompt only)
 *   1: Contextual hint ("Think about concept X")
 *   2: Structural hint ("The answer involves three components...")
 *   3: Partial solution ("The first step is...")
 *   4: Worked example with similar problem
 *   5: Full explanation + answer (last resort)
 *
 * Target: 70-85% success rate
 *   > 85% success → decrease level (min 0)
 *   < 70% success → increase level (max 5)
 *   70-85% → maintain current level
 */
export function computeScaffoldingLevel(
  recentQualities: number[],
  currentLevel: number,
): number {
  if (recentQualities.length < 3) return currentLevel;
  const successRate = recentQualities.filter(q => q >= 3).length / recentQualities.length;
  if (successRate > 0.85) return Math.max(0, currentLevel - 1);
  if (successRate < 0.70) return Math.min(5, currentLevel + 1);
  return currentLevel;
}

/**
 * Generate a hint based on the scaffolding level and reference answer.
 * Levels 1-2: derived from reference answer
 * Levels 3-5: progressive reveal of reference answer
 */
export function generateHint(referenceAnswer: string | null, level: number): string | null {
  if (!referenceAnswer || level <= 0) return null;

  if (level === 1) {
    // First sentence only
    const firstSentence = referenceAnswer.split(/[.!?]/)[0];
    return firstSentence ? `Hint: Think about "${firstSentence.trim()}..."` : null;
  }
  if (level === 2) {
    // Structural summary
    const sentences = referenceAnswer.split(/[.!?]/).filter(s => s.trim());
    return `Hint: The answer covers ${sentences.length} key point${sentences.length !== 1 ? 's' : ''}.`;
  }
  if (level === 3) {
    // 30% reveal
    const cutoff = Math.max(20, Math.floor(referenceAnswer.length * 0.3));
    return referenceAnswer.slice(0, cutoff) + '...';
  }
  if (level === 4) {
    // 60% reveal
    const cutoff = Math.max(20, Math.floor(referenceAnswer.length * 0.6));
    return referenceAnswer.slice(0, cutoff) + '...';
  }
  // Level 5: full answer
  return referenceAnswer;
}
