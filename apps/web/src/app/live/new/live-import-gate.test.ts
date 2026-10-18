import { readFileSync } from "node:fs";
import { join } from "node:path";
import { liveChannelPlanSchema, validateLiveChannel } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { tryImportLiveChannelIntoWizard } from "./live-plan-to-wizard";

/**
 * The Duplicate-channel round-trip gate — , review I6.
 *
 * Every input below is a channel an operator could have SAVED: each parses and
 * each validates with zero errors. That is the point. Before the gate,
 * `live-wizard.tsx` parsed and called `setState`, so all three re-opened as a
 * DIFFERENT channel with no warning anywhere.
 *
 * The refusals are only half the test. A gate that refuses everything passes
 * all three and destroys the feature, so the uniform channel below has to keep
 * opening — and its state has to be the one that rebuilds the plan exactly,
 * not merely a truthy result.
 */
const FIXTURE = join(
	__dirname,
	"../../../../../../packages/core/src/live/__fixtures__/live-hls-ts-muxed.plan.json",
);
const muxed = JSON.parse(readFileSync(FIXTURE, "utf8"));

/** Every input here must be a channel that was legal to save. */
const legalToSave = (raw: unknown) => {
	const parsed = liveChannelPlanSchema.safeParse(raw);
	expect(parsed.success, "input parses").toBe(true);
	if (!parsed.success) {
		return;
	}
	expect(
		validateLiveChannel(parsed.data).filter((i) => i.level === "error"),
		"input validates with no errors",
	).toEqual([]);
};

describe("tryImportLiveChannelIntoWizard", () => {
	it("opens a uniform channel — the counterfactual that keeps the refusals meaningful", () => {
		legalToSave(muxed);
		const result = tryImportLiveChannelIntoWizard(muxed);
		expect(result.ok).toBe(true);
		// Not just truthy: the state it hands back must be the one that rebuilds
		// this plan. `ok` is a claim about the round trip, so assert the claim.
		// The relation is on the CARRIER now, so that is what has to come back:
		// the rung names the track it carries, and the track knows it ships no
		// container of its own.
		expect(result.ok && result.state.videos[0]?.muxedAudioKeys).toEqual([
			"a128",
		]);
		expect(result.ok && result.state.audios[0]?.ownContainer).toBe(false);
	});

	it("refuses a plan that is not a live plan at all", () => {
		const result = tryImportLiveChannelIntoWizard({ nonsense: true });
		expect(result).toEqual({
			ok: false,
			reasonKey: "uiX.couldNotDuplicateInvalidPlan",
		});
	});

	/**
	 * WAS a refusal, is now an ACCEPTANCE — and the change is the point.
	 *
	 * Measured before the model was rewritten: SAVED `v540 +[a128] | v720` came
	 * back with BOTH rungs carrying a128, because the wizard held one flag per
	 * container KIND and re-broadcast it. The gate was the only thing standing
	 * between an operator and a silently different channel.
	 *
	 * The relation now lives on the rung, so the plan round-trips exactly and
	 * there is nothing to refuse. A gate that still refused this would be
	 * refusing a channel the form can now author — which is why this arm was
	 * inverted rather than deleted: the same input, the opposite verdict, for a
	 * stated reason.
	 */
	it("OPENS audio muxed into one rung — the form can now say that", () => {
		const oneRung = {
			...muxed,
			muxings: muxed.muxings.map((m: Record<string, unknown>, i: number) =>
				i === 0 ? m : { ...m, additionalStreamKeys: undefined },
			),
		};
		legalToSave(oneRung);
		const result = tryImportLiveChannelIntoWizard(oneRung);
		expect(result.ok).toBe(true);
		// And it opens carrying what it carried — not what the old readback
		// would have spread.
		expect(result.ok && result.state.videos[0]?.muxedAudioKeys).toEqual([
			"a128",
		]);
		expect(result.ok && result.state.videos[1]?.muxedAudioKeys).toBeUndefined();
	});

	/**
	 * Also inverted. The readback used to take the muxed branch first, so
	 * `containerOf` was never consulted and the fMP4 audio container vanished
	 * from the rebuild — taking the DASH audio representation with it.
	 *
	 * "Carried" and "has its own container" are independent facts in the model
	 * now, so a track can hold both and come back holding both.
	 */
	it("OPENS a track with BOTH its own container and a muxed ride", () => {
		const both = {
			...muxed,
			muxings: [
				...muxed.muxings,
				{
					key: "a128",
					kind: "FMP4",
					streamKey: "a128",
					segmentLength: 6,
					segmentNaming: "segment_%number%.m4s",
					initSegmentName: "init.mp4",
					destination: {
						outputKey: "origin",
						path: "output/live-hls-ts-muxed/audio/128000",
					},
				},
			],
		};
		legalToSave(both);
		const result = tryImportLiveChannelIntoWizard(both);
		expect(result.ok).toBe(true);
		// Its own container survives — that is the half the old readback ate.
		expect(result.ok && result.state.audios[0]?.ownContainer).not.toBe(false);
	});

	it("refuses an audio-primary container carrying a second audio track", () => {
		// Measured: a64 was re-homed into BOTH video legs and stripped from
		// a128's container — two tracks that shared one container split across
		// two others. The narrow guard fixes the re-homing; this asserts the
		// plan is still not form-representable, so it must not open silently.
		const pair = {
			...muxed,
			renditions: [
				...muxed.renditions,
				{
					key: "a64",
					codec: "AAC",
					ingestKey: "audio",
					bitrate: 64000,
					rate: 48000,
					channelLayout: "CL_STEREO",
				},
			],
			muxings: [
				...muxed.muxings.map((m: Record<string, unknown>) => ({
					...m,
					additionalStreamKeys: undefined,
				})),
				{
					key: "a128",
					kind: "TS",
					streamKey: "a128",
					additionalStreamKeys: ["a64"],
					segmentLength: 6,
					segmentNaming: "seg_%number%.ts",
					destination: {
						outputKey: "origin",
						path: "output/live-hls-ts-muxed/audio",
					},
				},
			],
		};
		legalToSave(pair);
		expect(tryImportLiveChannelIntoWizard(pair)).toEqual({
			ok: false,
			reasonKey: "uiX.couldNotDuplicateUnrepresentedOptions",
		});
	});
});
