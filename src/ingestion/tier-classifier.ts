const TIER_1_TYPES = new Set(['assignment', 'reference', 'project']);
const TIER_3_TYPES = new Set(['research']);

export interface TierInput {
  type: string | null;
  tierOverride?: number;
}

export function classifyTier(input: TierInput): number {
  if (input.tierOverride !== undefined) {
    return input.tierOverride;
  }
  if (input.type === null) {
    return 2; // Unknown type → auto-approve (most uploads are course materials)
  }
  if (TIER_1_TYPES.has(input.type)) {
    return 1;
  }
  if (TIER_3_TYPES.has(input.type)) {
    return 3;
  }
  return 2; // Default: course materials
}
