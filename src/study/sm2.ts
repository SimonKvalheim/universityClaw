// SM-2 Spaced Repetition Algorithm
// Spec: Section 4.1 — implements the SuperMemo 2 scheduling formula exactly.

export interface SM2Input {
  quality: number; // 0–5 rating of recall quality
  repetitions: number; // number of successful repetitions so far
  easeFactor: number; // current ease factor (default 2.5)
  intervalDays: number; // current inter-repetition interval in days
}

export interface SM2Result {
  easeFactor: number; // updated ease factor
  intervalDays: number; // next interval in days
  repetitions: number; // updated repetition count
}

/**
 * Compute the next SM-2 scheduling values.
 *
 * Formula (spec Section 4.1):
 *   EF' = EF + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
 *   EF' = max(EF', 1.3)
 *
 *   if quality >= 3:
 *     rep 0 → interval = 1
 *     rep 1 → interval = 6
 *     rep 2+ → interval = round(previousInterval * EF')
 *     repetitions += 1
 *   else:
 *     repetitions = 0, interval = 1
 */
export function sm2(input: SM2Input): SM2Result {
  const { quality, repetitions, easeFactor, intervalDays } = input;

  // Update ease factor
  const delta = 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02);
  const newEaseFactor = Math.max(easeFactor + delta, 1.3);

  let newRepetitions: number;
  let newIntervalDays: number;

  if (quality >= 3) {
    // Correct response
    if (repetitions === 0) {
      newIntervalDays = 1;
    } else if (repetitions === 1) {
      newIntervalDays = 6;
    } else {
      newIntervalDays = Math.round(intervalDays * newEaseFactor);
    }
    newRepetitions = repetitions + 1;
  } else {
    // Incorrect response — reset
    newRepetitions = 0;
    newIntervalDays = 1;
  }

  return {
    easeFactor: newEaseFactor,
    intervalDays: newIntervalDays,
    repetitions: newRepetitions,
  };
}

/**
 * Compute the due date by adding intervalDays to fromDate.
 *
 * @param intervalDays - Number of days to add
 * @param fromDate     - Base date in 'YYYY-MM-DD' format (defaults to today)
 * @returns Due date in 'YYYY-MM-DD' format
 */
export function computeDueDate(
  intervalDays: number,
  fromDate?: string,
): string {
  const base = fromDate ? new Date(`${fromDate}T00:00:00`) : new Date();
  // Normalise to midnight local time when no fromDate provided
  if (!fromDate) {
    base.setHours(0, 0, 0, 0);
  }
  base.setDate(base.getDate() + intervalDays);
  const year = base.getFullYear();
  const month = String(base.getMonth() + 1).padStart(2, '0');
  const day = String(base.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
