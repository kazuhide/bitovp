import { describe, expect, it } from "vitest";
import type { WizardManifests } from "./build-plan";
import { manifestPlacement } from "./rendition-editors";

/**
 * ManifestPlacement derivation: the dashSetKey select must say WHICH
 * manifest declares a set (same-named sets across manifests), dedupe
 * identical {key, type} pairs, and flag same-key/different-type conflicts
 * (PLAN_DASH_SET_TYPE_MISMATCH blocks those at validation).
 */
describe("manifestPlacement", () => {
	const base: WizardManifests = { hls: false, dash: false };

	it("tags every adaptation set with its declaring manifest", () => {
		const placement = manifestPlacement({
			...base,
			dash: true,
			dashOptions: {
				adaptationSets: [
					{ key: "video-dv", type: "VIDEO", lang: "en" },
					{ key: "audio-atmos", type: "AUDIO" },
				],
			},
			extra: [
				{
					kind: "DASH",
					key: "dash-ondemand",
					dash: { adaptationSets: [{ key: "video-sdr", type: "VIDEO" }] },
				},
			],
		});
		expect(placement.dashAdaptationSets).toEqual([
			{
				key: "video-dv",
				type: "VIDEO",
				lang: "en",
				label: undefined,
				manifestKeys: ["dash"],
			},
			{
				key: "audio-atmos",
				type: "AUDIO",
				lang: undefined,
				label: undefined,
				manifestKeys: ["dash"],
			},
			{
				key: "video-sdr",
				type: "VIDEO",
				lang: undefined,
				label: undefined,
				manifestKeys: ["dash-ondemand"],
			},
		]);
		expect(placement.conflictingDashSetKeys).toEqual([]);
	});

	it("dedupes identical {key, type} pairs across manifests into one option", () => {
		const placement = manifestPlacement({
			...base,
			dash: true,
			dashOptions: { adaptationSets: [{ key: "video", type: "VIDEO" }] },
			extra: [
				{
					kind: "DASH",
					key: "timeline",
					dash: { adaptationSets: [{ key: "video", type: "VIDEO" }] },
				},
			],
		});
		expect(placement.dashAdaptationSets).toHaveLength(1);
		expect(placement.dashAdaptationSets[0]?.manifestKeys).toEqual([
			"dash",
			"timeline",
		]);
		expect(placement.conflictingDashSetKeys).toEqual([]);
	});

	it("flags the same key declared with different types across manifests", () => {
		const placement = manifestPlacement({
			...base,
			dash: true,
			dashOptions: { adaptationSets: [{ key: "main", type: "VIDEO" }] },
			extra: [
				{
					kind: "DASH",
					key: "audio-only",
					dash: { adaptationSets: [{ key: "main", type: "AUDIO" }] },
				},
			],
		});
		// Both stay selectable (distinct {key, type}), and the conflict is named.
		expect(placement.dashAdaptationSets).toHaveLength(2);
		expect(placement.conflictingDashSetKeys).toEqual(["main"]);
	});

	it("ignores excluded primaries and non-DASH extras", () => {
		const placement = manifestPlacement({
			...base,
			// dash: false — its declared sets must not leak into the select.
			dashOptions: { adaptationSets: [{ key: "ghost", type: "VIDEO" }] },
			extra: [
				{ kind: "HLS", key: "hls2" },
				{ kind: "SMOOTH", key: "smooth" },
			],
		});
		expect(placement.dashAdaptationSets).toEqual([]);
		expect(placement.conflictingDashSetKeys).toEqual([]);
	});

	it("detects variantsPerAudioGroup on the primary or any extra HLS", () => {
		expect(manifestPlacement(base).variantsPerAudioGroup).toBe(false);
		expect(
			manifestPlacement({
				...base,
				hls: true,
				hlsOptions: { variantsPerAudioGroup: true },
			}).variantsPerAudioGroup,
		).toBe(true);
		expect(
			manifestPlacement({
				...base,
				extra: [
					{ kind: "HLS", key: "master2", hls: { variantsPerAudioGroup: true } },
				],
			}).variantsPerAudioGroup,
		).toBe(true);
	});
});
