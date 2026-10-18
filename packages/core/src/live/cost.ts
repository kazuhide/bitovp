import { z } from "zod";
import { renditionFamily } from "../plan/detail-view";
import type { LiveChannelPlan } from "./schema";

/**
 * Live run cost estimate .
 *
 * The rate card is OPERATOR data (their contract), stored in
 * `BitmovinAccount.defaults.rateCard` and edited in Settings → Bitmovin.
 * This module never fabricates a number: no card, no video ladder, or a
 * ladder taller than every tier each return a typed `unavailable` with the
 * reason — the UI says so instead of guessing. `assumptions` states exactly
 * what the arithmetic ignores (egress, storage, feeder compute, minimum
 * billing increments) and is RENDERED, not hidden.
 */

export const rateCardSchema = z.object({
	/** Display only — the estimate carries it verbatim ("USD", "¥"…). */
	currency: z.string().min(1).max(8),
	liveRates: z
		.array(
			z.object({
				/** Tier ceiling: applies to ladders whose tallest rendition ≤ this. */
				maxHeight: z.number().int().positive(),
				perHour: z.number().nonnegative(),
			}),
		)
		.min(1),
	notes: z.string().max(2_000).optional(),
});

export type RateCard = z.infer<typeof rateCardSchema>;

export type LiveCostEstimate =
	| {
			kind: "estimate";
			currency: string;
			/** The matched tier's ceiling, e.g. 1080. */
			tierMaxHeight: number;
			/** The ladder height that selected the tier. */
			ladderHeight: number;
			perHour: number;
			total: number;
			minutes: number;
			assumptions: string[];
	  }
	| {
			kind: "unavailable";
			reason:
				| "no-rate-card"
				| "no-video-ladder"
				| "ladder-exceeds-tiers"
				| "invalid-duration";
			/** For ladder-exceeds-tiers: what the card tops out at vs the ladder. */
			ladderHeight?: number;
			cardMaxHeight?: number;
	  };

/**
 * Pure. Tier selection = the SMALLEST tier whose maxHeight covers the
 * ladder's tallest video rendition (design §4: "highest rendition height").
 * Renditions with height null (per-title-style free scaling) are ignored
 * for tier selection and recorded as an assumption when present.
 */
export function estimateLiveRunCost(
	plan: LiveChannelPlan,
	minutes: number,
	card: RateCard | null | undefined,
): LiveCostEstimate {
	if (!card) {
		return { kind: "unavailable", reason: "no-rate-card" };
	}
	// review-84b N6: exported from core, so callers beyond the two guarded UI
	// sites exist tomorrow — a negative/NaN duration must not fabricate a
	// negative/NaN bill in a module whose whole point is cost honesty.
	if (!Number.isFinite(minutes) || minutes < 0) {
		return { kind: "unavailable", reason: "invalid-duration" };
	}
	const video = plan.renditions.filter(
		(rendition) => renditionFamily(rendition) === "video",
	);
	const heights = video
		.map((rendition) =>
			"height" in rendition ? (rendition.height ?? null) : null,
		)
		.filter((height): height is number => height !== null);
	if (heights.length === 0) {
		return { kind: "unavailable", reason: "no-video-ladder" };
	}
	const ladderHeight = Math.max(...heights);
	const tiers = [...card.liveRates].sort((a, b) => a.maxHeight - b.maxHeight);
	const tier = tiers.find((entry) => entry.maxHeight >= ladderHeight);
	if (!tier) {
		return {
			kind: "unavailable",
			reason: "ladder-exceeds-tiers",
			ladderHeight,
			cardMaxHeight: tiers[tiers.length - 1]?.maxHeight,
		};
	}
	const perHour = tier.perHour;
	const total = (perHour * minutes) / 60;
	const assumptions = [
		"encoding-minutes-only", // egress, storage, feeder compute excluded
		"no-billing-increments", // real contracts round up; this does not
	];
	if (video.length > heights.length) {
		// Some video renditions carry height null (free scaling) — they did
		// not participate in tier selection.
		assumptions.push("null-height-renditions-ignored");
	}
	return {
		kind: "estimate",
		currency: card.currency,
		tierMaxHeight: tier.maxHeight,
		ladderHeight,
		perHour,
		// Round to cents — the inputs are money-per-hour, not floats to 12
		// digits; anything finer implies precision the card does not have.
		total: Math.round(total * 100) / 100,
		minutes,
		assumptions,
	};
}

/** Parse a stored defaults.rateCard, tolerating absence and junk. */
export function rateCardFromDefaults(defaults: unknown): RateCard | null {
	if (
		typeof defaults !== "object" ||
		defaults === null ||
		!("rateCard" in defaults)
	) {
		return null;
	}
	const parsed = rateCardSchema.safeParse(
		(defaults as { rateCard: unknown }).rateCard,
	);
	return parsed.success ? parsed.data : null;
}
