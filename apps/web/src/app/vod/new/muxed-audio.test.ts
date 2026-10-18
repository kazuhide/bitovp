import { encodingPlanSchema, validatePlan } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
	type WizardState,
} from "./build-plan";
import { planToWizardState, tryImportPresetIntoWizard } from "./plan-to-wizard";

/**
 * WHICH CONTAINER CARRIES WHICH TRACK — .
 *
 * The first cut modelled this as one flag on the AUDIO row meaning "muxed into
 * the video", which broadcasts a track to every container of its kind. The
 * owner rejected it with the case that breaks it, and the case is ordinary:
 *
 *     videoA ← audioA   videoB ← audioB   videoC ← audioA
 *     videoD carries nothing   audioC ships standalone
 *
 * A many-to-many relation cannot live on one side of itself. The relation now
 * sits on the CARRIER (`muxedAudioKeys` on a video leg), which is where the
 * plan schema always had it — `additionalStreamKeys` is per-muxing, and the
 * compiler, C33 and every rail handled the case above with zero issues before
 * a line of this rewrite. Only the wizard could not say it.
 */

const base: WizardState = {
	...DEFAULT_WIZARD_STATE,
	name: "muxed",
	cloudRegion: "AWS_AP_NORTHEAST_1",
	encoderVersion: "STABLE",
	inputFiles: [
		{
			key: "main",
			inputKey: "main",
			kind: "S3",
			credentialId: "00000000-0000-4000-8000-000000000001",
			bucket: "in",
			path: "a.mp4",
		},
	],
	output: {
		kind: "S3",
		credentialId: "00000000-0000-4000-8000-000000000002",
		bucket: "out",
		basePath: "output/muxed/",
	},
} as WizardState;

const ts = (muxedAudioKeys?: string[]) => ({
	kind: "TS" as const,
	...(muxedAudioKeys ? { muxedAudioKeys } : {}),
});

/** The owner's case, as wizard state. Keys are the derived a{kbps}/v{height}. */
const ownersCase = (): WizardState =>
	({
		...base,
		videos: [
			{ height: 360, bitrate: 800000, codec: "H264", muxing: ts(["a128"]) },
			{ height: 540, bitrate: 1500000, codec: "H264", muxing: ts(["a96"]) },
			{ height: 720, bitrate: 2400000, codec: "H264", muxing: ts(["a128"]) },
			{ height: 1080, bitrate: 5000000, codec: "H264", muxing: ts() },
		],
		audios: [
			{
				codec: "AAC",
				bitrate: 128000,
				rate: 48000,
				muxing: { kind: "TS", ownContainer: false },
			},
			{
				codec: "AAC",
				bitrate: 96000,
				rate: 48000,
				muxing: { kind: "TS", ownContainer: false },
			},
			{ codec: "AAC", bitrate: 64000, rate: 48000, muxing: { kind: "TS" } },
		],
	}) as WizardState;

const planOf = (state: WizardState) =>
	encodingPlanSchema.parse(buildPlan(state));

const carriedBy = (plan: ReturnType<typeof planOf>) =>
	Object.fromEntries(
		plan.muxings.map((m) => [
			m.streamKey,
			"additionalStreamKeys" in m ? (m.additionalStreamKeys ?? null) : null,
		]),
	);

describe("the owner's case", () => {
	it("gives each rung the track that rung was assigned", () => {
		expect(carriedBy(planOf(ownersCase()))).toEqual({
			v360: ["a128"],
			v540: ["a96"],
			v720: ["a128"],
			v1080: null,
			a64: null,
		});
	});

	it("ships a64 standalone and gives a128/a96 no container of their own", () => {
		const keys = planOf(ownersCase()).muxings.map((m) => m.streamKey);
		expect(keys).toContain("a64");
		expect(keys).not.toContain("a128");
		expect(keys).not.toContain("a96");
	});

	it("validates with no errors", () => {
		expect(
			validatePlan(planOf(ownersCase())).filter((i) => i.level === "error"),
		).toEqual([]);
	});

	it("survives a re-open, rung by rung", () => {
		// The half the broadcast model destroyed: a track assigned to ONE rung
		// came back on ALL of them, because the readback only remembered the
		// container KIND. This is the assertion that would have caught it.
		const plan = planOf(ownersCase());
		const rebuilt = encodingPlanSchema.parse(
			buildPlan(planToWizardState(plan) as WizardState),
		);
		expect(rebuilt.muxings).toEqual(plan.muxings);
	});

	it("opens in the wizard form rather than falling back to a verbatim import", () => {
		// The round-trip gate deep-equals; a model that could not express this
		// plan would refuse it here, which is how the old one would have failed.
		const result = tryImportPresetIntoWizard(
			JSON.parse(JSON.stringify(planOf(ownersCase()))),
		);
		expect(result.ok).toBe(true);
	});
});

describe("a track with no carrier keeps its container whatever the operator asked", () => {
	it("ignores ownContainer:false when nothing carries the track", () => {
		// Otherwise the choice deletes the audio from the delivery. Same rule
		// that survived three axes of this bug: a working delivery is the right
		// answer to a choice that cannot be honoured.
		const state = {
			...base,
			videos: [{ height: 360, bitrate: 800000, codec: "H264", muxing: ts() }],
			audios: [
				{
					codec: "AAC",
					bitrate: 128000,
					rate: 48000,
					muxing: { kind: "TS", ownContainer: false },
				},
			],
		} as WizardState;
		const plan = planOf(state);
		expect(plan.muxings.map((m) => m.streamKey)).toContain("a128");
		expect(validatePlan(plan).filter((i) => i.level === "error")).toEqual([]);
	});

	it("honours it when something does", () => {
		// The counterfactual: a builder that always emitted the container would
		// pass the arm above while never producing the classic muxed layout.
		const state = {
			...base,
			videos: [
				{ height: 360, bitrate: 800000, codec: "H264", muxing: ts(["a128"]) },
			],
			audios: [
				{
					codec: "AAC",
					bitrate: 128000,
					rate: 48000,
					muxing: { kind: "TS", ownContainer: false },
				},
			],
		} as WizardState;
		expect(planOf(state).muxings.map((m) => m.streamKey)).not.toContain("a128");
	});
});

describe("a container that cannot carry a second stream drops the assignment", () => {
	it("ignores muxedAudioKeys on an fMP4 leg, and keeps the track packaged", () => {
		// `additionalStreamKeys` is TS/MP4 only in the schema, so an fMP4 leg
		// cannot hold the assignment. The track must not vanish because of it.
		const state = {
			...base,
			videos: [
				{
					height: 360,
					bitrate: 800000,
					codec: "H264",
					muxing: { kind: "FMP4", muxedAudioKeys: ["a128"] },
				},
			],
			audios: [
				{
					codec: "AAC",
					bitrate: 128000,
					rate: 48000,
					muxing: { kind: "FMP4", ownContainer: false },
				},
			],
		} as WizardState;
		const plan = planOf(state);
		expect(plan.muxings.map((m) => m.streamKey)).toContain("a128");
		expect(validatePlan(plan).filter((i) => i.level === "error")).toEqual([]);
	});
});
