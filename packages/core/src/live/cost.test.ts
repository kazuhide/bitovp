import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	estimateLiveRunCost,
	type RateCard,
	rateCardFromDefaults,
} from "./cost";
import { liveChannelPlanSchema } from "./schema";

/**
 *  PR3 (design §8): the estimate is pure arithmetic over a REAL
 * schema-parsed plan — no-card, no-video and exceeds-tiers paths return
 * typed unavailability, never a fabricated number. The plan comes from a
 * golden fixture (the ladder-panel lesson: hand-built `as unknown as`
 * fixtures measure a world the schema cannot produce).
 */

const realPlan = liveChannelPlanSchema.parse(
	JSON.parse(
		readFileSync(
			join(__dirname, "__fixtures__/live-esam-full.plan.json"),
			"utf8",
		),
	),
);

const ladderHeight = Math.max(
	...realPlan.renditions
		.map((r) => ("height" in r ? (r.height ?? null) : null))
		.filter((h): h is number => h !== null),
);

const CARD: RateCard = {
	currency: "USD",
	liveRates: [
		{ maxHeight: 720, perHour: 3 },
		{ maxHeight: 1080, perHour: 6 },
		{ maxHeight: 2160, perHour: 12 },
	],
};

describe("estimateLiveRunCost", () => {
	it("selects the SMALLEST covering tier and does the minutes arithmetic", () => {
		const result = estimateLiveRunCost(realPlan, 90, CARD);
		expect(result.kind).toBe("estimate");
		if (result.kind !== "estimate") {
			return;
		}
		// The fixture's tallest video rendition picks its covering tier —
		// derived here from the SAME plan, so the test moves with the fixture.
		const expectedTier = CARD.liveRates.find(
			(t) => t.maxHeight >= ladderHeight,
		);
		expect(result.tierMaxHeight).toBe(expectedTier?.maxHeight);
		expect(result.ladderHeight).toBe(ladderHeight);
		expect(result.perHour).toBe(expectedTier?.perHour);
		expect(result.total).toBe(
			Math.round(((expectedTier?.perHour ?? 0) * 90 * 100) / 60) / 100,
		);
		expect(result.currency).toBe("USD");
		expect(result.assumptions).toContain("encoding-minutes-only");
	});

	it("a ladder exactly AT a tier ceiling belongs to that tier", () => {
		const card: RateCard = {
			currency: "USD",
			liveRates: [{ maxHeight: ladderHeight, perHour: 5 }],
		};
		const result = estimateLiveRunCost(realPlan, 60, card);
		expect(result).toMatchObject({
			kind: "estimate",
			tierMaxHeight: ladderHeight,
			total: 5,
		});
	});

	it("no card ⇒ typed unavailable, never a number", () => {
		expect(estimateLiveRunCost(realPlan, 60, null)).toEqual({
			kind: "unavailable",
			reason: "no-rate-card",
		});
	});

	it("a ladder taller than every tier ⇒ unavailable naming both heights", () => {
		const card: RateCard = {
			currency: "USD",
			liveRates: [{ maxHeight: ladderHeight - 1, perHour: 3 }],
		};
		expect(estimateLiveRunCost(realPlan, 60, card)).toEqual({
			kind: "unavailable",
			reason: "ladder-exceeds-tiers",
			ladderHeight,
			cardMaxHeight: ladderHeight - 1,
		});
	});

	it("an audio-only plan ⇒ no-video-ladder", () => {
		const audioOnly = {
			...realPlan,
			renditions: realPlan.renditions.filter(
				(r) => !("height" in r) || r.height === null,
			),
		};
		// Guard the guard: the filter must leave SOMETHING or the test is
		// measuring an empty world.
		expect(audioOnly.renditions.length).toBeGreaterThan(0);
		expect(estimateLiveRunCost(audioOnly, 60, CARD)).toEqual({
			kind: "unavailable",
			reason: "no-video-ladder",
		});
	});
});

describe("rateCardFromDefaults", () => {
	it("reads a valid stored card", () => {
		expect(rateCardFromDefaults({ rateCard: CARD })).toEqual(CARD);
	});

	it("absent / junk / malformed each degrade to null, never a throw", () => {
		expect(rateCardFromDefaults({})).toBeNull();
		expect(rateCardFromDefaults(null)).toBeNull();
		expect(rateCardFromDefaults("junk")).toBeNull();
		expect(rateCardFromDefaults({ rateCard: { currency: "USD" } })).toBeNull();
		expect(
			rateCardFromDefaults({
				rateCard: { currency: "USD", liveRates: [] },
			}),
		).toBeNull();
	});
});
