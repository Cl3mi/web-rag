/**
 * Training Weight Calculator
 *
 * Computes a training weight for each chat message based on:
 *  1. Base weight derived from user rating + failure category
 *  2. Frequency boost for rare categories (prevents underrepresentation)
 *  3. Hard clip to [0.3, 2.0]
 */

import { sql } from '$lib/server/db/client';

export type RatingCategory =
  | 'hallucination'
  | 'incomplete'
  | 'irrelevant'
  | 'misleading'
  | 'off_topic'
  | 'other';

/** Base weights by (rating, category). Thumbs-up is always 1.0 (reliable positive example). */
const CATEGORY_BASE_WEIGHTS: Record<RatingCategory, number> = {
  hallucination: 1.8,  // Critical — safety / trust issue
  misleading:    1.5,  // High — misleads user
  irrelevant:    1.3,  // Medium — off-topic retrieval
  incomplete:    1.2,  // Medium — missing info
  off_topic:     0.8,  // Low — query out of scope
  other:         1.0,  // Baseline — unspecified issue
};

/**
 * Base weights by judge failure_type in rag_judge_results.
 * Mirrors CATEGORY_BASE_WEIGHTS but keyed on automated pipeline failure types.
 */
export const FAILURE_TYPE_BASE_WEIGHTS: Record<string, number> = {
  hallucination_failure: 1.8,  // Critical — safety/trust issue
  generation_failure:    1.4,  // Answer quality problem
  robust_generation:     1.3,  // Valuable: answered despite poor retrieval
  normal:                1.0,  // Standard positive example
  retrieval_failure:     0.4,  // Low value — context gap, not a generation signal
};

const WEIGHT_MIN = 0.3;
const WEIGHT_MAX = 2.0;

/** Clip weight to [0.3, 2.0]. */
function clip(w: number): number {
  return Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, w));
}

/**
 * Calculate a single training weight.
 *
 * @param rating     'up' | 'down' | null
 * @param category   Failure category (only used when rating = 'down')
 * @param distribution  Current counts per category across all rated-down messages
 */
export function calculateWeight(
  rating: 'up' | 'down' | null,
  category: RatingCategory | null | undefined,
  distribution: Record<string, number>
): number {
  let base = 1.0;

  if (rating === 'down' && category) {
    base = CATEGORY_BASE_WEIGHTS[category] ?? 1.0;

    // Frequency boost: rare categories (< 10 % of rated-down pool) get up to ×1.3
    const total = Object.values(distribution).reduce((a, b) => a + b, 0);
    if (total > 0) {
      const freq = (distribution[category] ?? 0) / total;
      if (freq < 0.1) {
        const boost = 1 + (0.1 - freq) * 3; // linear, max ≈ 1.3 at 0 %
        base *= Math.min(boost, 1.3);
      }
    }
  }

  return clip(base);
}

/**
 * Calculate training weight from an automated failure_type.
 * Uses FAILURE_TYPE_BASE_WEIGHTS + frequency boost for rare types.
 *
 * @param failureType  Value from rag_judge_results.failure_type
 * @param distribution  Current counts per failure_type across all judged rows
 */
export function calculateWeightFromFailureType(
  failureType: string | null,
  distribution: Record<string, number>
): number {
  if (!failureType) return 1.0;

  let base = FAILURE_TYPE_BASE_WEIGHTS[failureType] ?? 1.0;

  // Frequency boost: rare failure types (< 10% share) get up to ×1.3
  const total = Object.values(distribution).reduce((a, b) => a + b, 0);
  if (total > 0) {
    const freq = (distribution[failureType] ?? 0) / total;
    if (freq < 0.1) {
      const boost = 1 + (0.1 - freq) * 3;
      base *= Math.min(boost, 1.3);
    }
  }

  return clip(base);
}

/**
 * Fetch the distribution of failure_type values across all judged rag rows.
 */
export async function getFailureTypeDistribution(): Promise<Record<string, number>> {
  const rows = await sql`
    SELECT failure_type, COUNT(*)::integer AS cnt
    FROM rag_judge_results
    WHERE failure_type IS NOT NULL
    GROUP BY failure_type
  `;
  const dist: Record<string, number> = {};
  for (const r of rows) {
    dist[r.failure_type as string] = r.cnt as number;
  }
  return dist;
}

/**
 * Fetch the distribution of rating_category values across all thumbs-down chat_messages.
 */
export async function getDistribution(): Promise<Record<string, number>> {
  const rows = await sql`
    SELECT rating_category, COUNT(*)::integer AS cnt
    FROM chat_messages
    WHERE rating = 'down' AND rating_category IS NOT NULL
    GROUP BY rating_category
  `;
  const dist: Record<string, number> = {};
  for (const r of rows) {
    dist[r.rating_category as string] = r.cnt as number;
  }
  return dist;
}

/**
 * Bulk-recalculate training_weight for all chat_messages that don't yet have
 * a manually overridden weight (i.e. all rows). Frequency distribution is
 * computed once and reused across all rows.
 *
 * Returns the number of rows updated.
 */
export async function recalculateAllWeights(): Promise<number> {
  const distribution = await getDistribution();

  const rows = await sql`
    SELECT id, rating, rating_category
    FROM chat_messages
    WHERE rating IS NOT NULL
  `;

  let updated = 0;
  for (const row of rows) {
    const w = calculateWeight(
      row.rating as 'up' | 'down',
      row.rating_category as RatingCategory | null,
      distribution
    );
    await sql`
      UPDATE chat_messages
      SET training_weight = ${w}
      WHERE id = ${row.id as string}
    `;
    updated++;
  }
  return updated;
}
