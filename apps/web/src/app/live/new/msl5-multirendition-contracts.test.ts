import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	compileLiveChannel,
	liveChannelPlanSchema,
	validateLiveChannel,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { buildLiveChannelPlan, withMslStreamFormat } from "./build-live-plan";
import { planToLiveWizardState } from "./live-plan-to-wizard";

const CREDENTIAL = "00000000-0000-4000-8000-0000000000a5";
const LADDER = [
	["v1080", 4_100_000, "video/1080p"],
	["v720", 2_700_000, "video/720p"],
	["v360", 650_000, "video/360p"],
	["a128", 128_000, "audio/128000"],
] as const;

function editedState() {
	const fixture = liveChannelPlanSchema.parse(
		JSON.parse(
			readFileSync(
				join(
					__dirname,
					"../../../../../../packages/core/src/live/__fixtures__/live-akamai-msl5.plan.json",
				),
				"utf8",
			),
		),
	);
	const state = planToLiveWizardState(fixture);
	// An edited ladder, not another deep-equality test of the existing golden.
	return {
		...state,
		output: { ...state.output, credentialId: CREDENTIAL },
		videos: state.videos.map((row, index) => ({
			...row,
			bitrate: LADDER[index]?.[1] ?? null,
		})),
	};
}

function built(format: "CMAF" | "HLS") {
	return liveChannelPlanSchema.parse(
		buildLiveChannelPlan(withMslStreamFormat(editedState(), format)),
	);
}

describe("edited MSL5 3V1A wizard → validator → compiler contract", () => {
	it.each([
		"CMAF",
		"HLS",
	] as const)("binds every %s rendition to its own codec, muxing and manifest entry", (format) => {
		const plan = built(format);
		expect(validateLiveChannel(plan)).toEqual([]);
		const ops = compileLiveChannel(plan);
		expect(ops.filter((op) => op.kind === "CREATE_STREAM")).toHaveLength(4);
		const muxings = ops.filter((op) => op.kind.startsWith("CREATE_MUXING_"));
		expect(muxings).toHaveLength(4);
		expect(new Set(muxings.map((op) => op.payload.outputPath)).size).toBe(4);
		for (const [key, bitrate, suffix] of LADDER) {
			const audio = key === "a128";
			expect(
				ops.find((op) => op.step === `codec:${key}`)?.payload.bitrate,
			).toBe(bitrate);
			expect(ops.find((op) => op.step === `stream:${key}`)).toMatchObject({
				payload: { position: audio ? 1 : 0 },
				refs: {
					codecConfigId: `codec:${key}`,
					inputId: "live-input:main",
					encodingId: "encoding",
				},
			});
			expect(ops.find((op) => op.step === `muxing:${key}`)).toMatchObject({
				kind: format === "HLS" ? "CREATE_MUXING_TS" : "CREATE_MUXING_FMP4",
				payload: {
					segmentNaming:
						format === "HLS"
							? "$RepresentationID$_$Number$.ts"
							: "$RepresentationID$_$Number$.m4s",
				},
				refs: { streamId: `stream:${key}`, outputId: "output:origin" },
			});
			const muxing = ops.find((op) => op.step === `muxing:${key}`);
			expect(muxing?.payload.outputPath).toBe(
				`output/live-akamai-msl5/${suffix}`,
			);
			if (format === "CMAF")
				expect(muxing?.payload.initSegmentName).toBe(
					"$RepresentationID$_init.mp4",
				);
			else expect(muxing?.payload).not.toHaveProperty("initSegmentName");
			expect(
				ops.find(
					(op) =>
						op.step === `${audio ? "hls-media" : "hls-variant"}:hls:${key}`,
				),
			).toMatchObject({
				payload: {
					uri: `${audio ? "audio" : "video"}_${bitrate}.m3u8`,
					segmentPath: `output/live-akamai-msl5/${suffix}`,
				},
				refs: {
					streamId: `stream:${key}`,
					muxingId: `muxing:${key}`,
					manifestId: "manifest:hls",
				},
			});
		}
		const dash = ops.filter(
			(op) => op.kind === "CREATE_DASH_REPRESENTATION_FMP4",
		);
		expect(dash.map((op) => op.refs.muxingId)).toEqual(
			format === "CMAF" ? LADDER.map(([key]) => `muxing:${key}`) : [],
		);
		expect(
			ops.find((op) => op.kind === "START_LIVE_ENCODING")?.refs,
		).toMatchObject({
			liveHlsManifestIds: ["manifest:hls"],
			...(format === "CMAF" ? { liveDashManifestIds: ["manifest:dash"] } : {}),
		});
	});

	it("keeps the vaulted credential reference while toggling MSL5 → MSL4 → MSL5, with version-correct names on all four legs", () => {
		const state = editedState();
		for (const version of ["MSL5", "MSL4", "MSL5"] as const) {
			const plan = liveChannelPlanSchema.parse(
				buildLiveChannelPlan({
					...state,
					output: { ...state.output, mslVersion: version },
				}),
			);
			expect(validateLiveChannel(plan)).toEqual([]);
			const ops = compileLiveChannel(plan);
			const output = ops.find((op) => op.kind === "CREATE_OUTPUT_AKAMAI_MSL");
			expect(output?.payload).toEqual({
				name: "Akamai MSL5 Output",
				credentialId: CREDENTIAL,
				streamFormat: "CMAF",
				mslVersion: version,
			});
			const muxings = ops.filter((op) => op.kind === "CREATE_MUXING_FMP4");
			expect(muxings).toHaveLength(4);
			for (const muxing of muxings) {
				expect(muxing.payload.segmentNaming).toBe(
					version === "MSL5"
						? "$RepresentationID$_$Number$.m4s"
						: "seg-{rand_chars:8}-%number%.m4s",
				);
				expect(muxing.payload.initSegmentName).toBe(
					version === "MSL5" ? "$RepresentationID$_init.mp4" : "init.mp4",
				);
			}
			expect(JSON.stringify(ops)).not.toMatch(
				/publishingAuthentication|"username"|"password"/,
			);
		}
	});

	it("rejects one leg accidentally retaining MSL4 media naming, including the audio leg", () => {
		for (const [key] of LADDER) {
			const plan = built("CMAF");
			const index = plan.muxings.findIndex((muxing) => muxing.key === key);
			const muxing = plan.muxings[index];
			if (!muxing || muxing.kind === "MP4")
				throw new Error(`Missing segmented ${key}`);
			muxing.segmentNaming = "seg-{rand_chars:8}-%number%.m4s";
			expect(validateLiveChannel(plan)).toContainEqual(
				expect.objectContaining({
					code: "C31",
					level: "error",
					path: `muxings.${index}.segmentNaming`,
				}),
			);
		}
	});

	it("rejects TS-only legs under CMAF, but accepts those four legs when the wizard explicitly selects HLS", () => {
		const plan = built("HLS");
		expect(validateLiveChannel(plan)).toEqual([]);
		const output = plan.outputs[0];
		if (output?.kind !== "AKAMAI_MSL")
			throw new Error("fixture lost MSL output");
		output.streamFormat = "CMAF";
		expect(validateLiveChannel(plan)).toContainEqual(
			expect.objectContaining({ code: "C31", level: "error" }),
		);
	});
});
