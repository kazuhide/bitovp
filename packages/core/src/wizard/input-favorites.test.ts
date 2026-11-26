import { describe, expect, it } from "vitest";
import { encodingPlanSchema } from "../plan/schema";
import type { VodInputFavoriteWire } from "../vod-input-timeline/favorites";
import * as wizard from "./index";

const id = "00000000-0000-4000-8000-000000000001";
const favorite: VodInputFavoriteWire = {
	id,
	credentialId: id,
	bucket: "input",
	objectKey: "intro.mp4",
	label: "Intro",
	kind: "VIDEO",
	availability: "AVAILABLE",
	inputKind: "S3",
};
const state: wizard.WizardState = {
	...wizard.DEFAULT_WIZARD_STATE,
	name: "Fixed asset test",
	accountId: id,
	inputFiles: [
		{
			key: "main",
			inputKey: "input",
			kind: "S3",
			credentialId: id,
			bucket: "input",
			path: "main.mp4",
		},
	],
	output: {
		...wizard.DEFAULT_WIZARD_STATE.output,
		credentialId: id,
		bucket: "output",
	},
	videos: [{ codec: "H264", height: 720, bitrate: 1_000_000 }],
};
const keys = () => {
	let n = 0;
	return () => `key_${n++}`;
};

describe("VOD fixed source snapshots", () => {
	it.each([
		"VIDEO",
		"AUDIO",
	] as const)("copies a %s input without changing the project sequence or the favorite", (kind) => {
		const input = { ...favorite, kind },
			before = structuredClone(state);
		const result = wizard.applyVodInputFavorite(state, input, keys());
		expect(result.usage).toBe("MEDIA");
		expect(result.state.inputFiles.at(-1)).toMatchObject({
			credentialId: id,
			bucket: "input",
			path: "intro.mp4",
			kind: "S3",
		});
		expect(result.state.inputFiles.at(-1)?.key).toBe(result.sourceKey);
		expect(result.state.inputFiles.at(-1)?.inputKey).toBe("input");
		input.objectKey = "changed.mp4";
		expect(result.state.inputFiles.at(-1)?.path).toBe("intro.mp4");
		expect(result.state.inputTimeline).toBe(state.inputTimeline);
		expect(state).toEqual(before);
	});
	it("does not duplicate an already imported object", () => {
		const result = wizard.applyVodInputFavorite(
			state,
			{ ...favorite, objectKey: "main.mp4" },
			() => {
				throw new Error("No key needed");
			},
		);
		expect(result.state).toBe(state);
		expect(result.sourceKey).toBe("main");
	});
	it("fills the default empty main slot rather than appending after an invalid input", () => {
		const empty = wizard.DEFAULT_WIZARD_STATE.inputFiles[0];
		if (!empty) throw new Error("Default main slot missing");
		const result = wizard.applyVodInputFavorite(
			wizard.DEFAULT_WIZARD_STATE,
			favorite,
			() => {
				throw new Error("Reuse empty keys");
			},
		);
		expect(result.state.inputFiles).toHaveLength(1);
		expect(result.state.inputFiles[0]).toMatchObject({
			key: empty.key,
			inputKey: empty.inputKey,
			credentialId: id,
			path: "intro.mp4",
		});
		expect(wizard.DEFAULT_WIZARD_STATE.inputFiles[0]?.path).toBe("");
	});
	it("counts only real media inputs against the source cap", () => {
		const base: wizard.WizardState = {
			...state,
			inputFiles: Array.from({ length: 16 }, (_, n) => ({
				...state.inputFiles[0],
				key: `media${n}`,
				inputKey: "input",
				kind: "S3",
				credentialId: id,
				bucket: "input",
				path: `${n}.mp4`,
			})),
		};
		expect(() => wizard.applyVodInputFavorite(base, favorite, keys())).toThrow(
			"FAVORITE_SOURCE_LIMIT",
		);
		const withImage: wizard.WizardState = {
			...base,
			inputFiles: [
				...base.inputFiles.slice(0, 15),
				{
					...base.inputFiles[0],
					key: "image",
					inputKey: "input",
					kind: "S3",
					credentialId: id,
					bucket: "input",
					path: "logo.png",
					purpose: "FILTER_IMAGE",
				},
			],
		};
		expect(
			wizard.applyVodInputFavorite(withImage, favorite, keys()).usage,
		).toBe("MEDIA");
	});
	it("connects a PNG to native WATERMARK output without making it a timeline source", () => {
		const image: VodInputFavoriteWire = {
				...favorite,
				kind: "IMAGE",
				objectKey: "logo.png",
			},
			before = structuredClone(state);
		const result = wizard.applyVodInputFavorite(state, image, keys());
		expect(result.usage).toBe("LOGO");
		expect(result.state.inputFiles.at(-1)).toMatchObject({
			path: "logo.png",
			purpose: "FILTER_IMAGE",
		});
		expect(result.state.filters).toEqual([
			{
				key: "fav_filter_key_1",
				kind: "WATERMARK",
				inputKey: "input",
				imagePath: "logo.png",
				left: 0,
				top: 0,
			},
		]);
		expect(result.state.videos[0]?.extras?.filters).toEqual([
			{ filterKey: "fav_filter_key_1", position: 0 },
		]);
		expect(result.state.inputTimeline).toBe(state.inputTimeline);
		const plan = encodingPlanSchema.parse(wizard.buildPlan(result.state));
		expect(plan.filters?.[0]).toMatchObject({
			kind: "WATERMARK",
			inputKey: "input",
			imagePath: "logo.png",
		});
		expect(JSON.stringify(plan)).not.toContain("FILTER_IMAGE");
		expect(JSON.stringify(plan)).not.toContain("https://");
		expect(state).toEqual(before);
		const again = wizard.applyVodInputFavorite(result.state, image, () => {
			throw new Error("No duplicate allocation");
		});
		expect(again.state.filters).toEqual(result.state.filters);
		expect(again.state.videos[0]?.extras?.filters).toEqual(
			result.state.videos[0]?.extras?.filters,
		);
	});
	it("preserves existing filter order when applying the logo to every video rendition", () => {
		const video = state.videos[0];
		if (!video) throw new Error("Video fixture missing");
		const base = {
			...state,
			filters: [{ key: "scale", kind: "SCALE" as const, width: 1280 }],
			videos: [
				{
					...video,
					extras: { filters: [{ filterKey: "scale", position: 3 }] },
				},
				{ ...video },
			],
		};
		const result = wizard.applyVodInputFavorite(
			base,
			{ ...favorite, kind: "IMAGE", objectKey: "logo.jpg" },
			keys(),
		);
		expect(result.state.videos[0]?.extras?.filters).toEqual([
			{ filterKey: "scale", position: 3 },
			{ filterKey: "fav_filter_key_1", position: 4 },
		]);
		expect(result.state.videos[1]?.extras?.filters).toEqual([
			{ filterKey: "fav_filter_key_1", position: 0 },
		]);
	});
	it("refuses unavailable references and a logo with no source video", () => {
		expect(() =>
			wizard.applyVodInputFavorite(
				state,
				{
					...favorite,
					availability: "CREDENTIAL_UNAVAILABLE",
					inputKind: null,
				},
				keys(),
			),
		).toThrowError("FAVORITE_UNAVAILABLE");
		expect(() =>
			wizard.applyVodInputFavorite(
				{ ...state, videos: [] },
				{ ...favorite, kind: "IMAGE", objectKey: "logo.png" },
				keys(),
			),
		).toThrowError("LOGO_NEEDS_VIDEO");
	});
});
