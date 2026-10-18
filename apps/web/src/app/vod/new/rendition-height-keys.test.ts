import { describe, expect, it } from "vitest";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
	videoKeys,
	type WizardState,
} from "./build-plan";
import { addVodVideo, updateVodVideoHeight } from "./rendition-copy";

function copiedState(key?: string): WizardState {
	const state = structuredClone(DEFAULT_WIZARD_STATE);
	state.videos = [
		{ height: 1080, bitrate: 4_000_000, ...(key ? { extras: { key } } : {}) },
	];
	return { ...state, ...addVodVideo(state, 0) };
}

function copiedVideo(state: WizardState) {
	const video = state.videos[1];
	if (!video?.extras || !video.muxing)
		throw new Error("Missing copied video identity");
	return { video, extras: video.extras, muxing: video.muxing };
}

describe("automatic VOD video keys follow height", () => {
	it("renames an automatic copy, its generated muxings and every rendition/muxing reference atomically", () => {
		const state = copiedState();
		const { video, muxing } = copiedVideo(state);
		video.extraMuxings = [
			{
				key: "v1080-2-mux2",
				kind: "MP4",
				path: "archive/copied",
				filename: "archive.mp4",
			},
		];
		muxing.muxedAudioKeys = ["a128"];
		state.audios = [
			{ bitrate: 128_000, rate: 48000, muxing: { ownContainer: false } },
		];
		state.drm = [
			{
				kind: "CENC",
				key: "v1080-2-cenc",
				muxingKey: "v1080-2",
				credentialId: "vault",
				kid: "kid",
				path: "protected/copied",
			},
			{
				kind: "CENC",
				key: "named-drm",
				muxingKey: "v1080-2-mux2",
				credentialId: "vault",
				kid: "kid",
				path: "protected/archive",
			},
		];
		state.thumbnails = [
			{ key: "thumb", streamKey: "v1080-2", height: 180, positions: [0] },
		];
		state.sprites = [
			{
				key: "sprite",
				streamKey: "v1080-2",
				distance: 10,
				height: 180,
				filename: "sprite.jpg",
			},
		];
		state.qc = {
			vmaf: true,
			psnr: false,
			model: "vmaf_v0.6.1",
			gate: {
				onFail: "BLOCK_MANIFESTS",
				rules: [
					{
						metric: "VMAF_MEAN",
						gte: 80,
						scope: "PER_RENDITION",
						renditions: ["v1080-2", "v1080"],
					},
				],
			},
		};
		const before = buildPlan(state);
		const next = { ...state, ...updateVodVideoHeight(state, 1, 900) };
		expect(videoKeys(next.videos)).toEqual(["v1080", "v900"]);
		expect(next.videos[1]?.muxing?.key).toBe("v900");
		expect(next.videos[1]?.extraMuxings?.[0]?.key).toBe("v900-mux2");
		expect(next.videos[1]?.muxing?.muxedAudioKeys).toEqual(["a128"]);
		expect(next.drm?.map((row) => [row.key, row.muxingKey])).toEqual([
			["v900-cenc", "v900"],
			["named-drm", "v900-mux2"],
		]);
		expect(next.thumbnails?.[0]?.streamKey).toBe("v900");
		expect(next.sprites?.[0]?.streamKey).toBe("v900");
		expect(next.qc?.gate?.rules[0]?.renditions).toEqual(["v900", "v1080"]);
		const after = buildPlan(next);
		expect(
			after.muxings.find((row) => row.key === "v900")?.destination?.path,
		).toBe("video/v900");
		for (const key of ["v1080", "v900-mux2"])
			expect(after.muxings.find((row) => row.key === key)?.destination).toEqual(
				before.muxings.find(
					(row) => row.key === (key === "v1080" ? key : "v1080-2-mux2"),
				)?.destination,
			);
		expect(after.drm?.map((row) => row.destination)).toEqual(
			before.drm?.map((row) => row.destination),
		);
		expect(state.videos[1]?.extras?.key).toBe("v1080-2");
		expect(JSON.stringify(after)).not.toContain("autoKey");
		expect(JSON.stringify(after)).not.toContain("autoPath");
	});
	it("updates the actual Per-Title copy destination while preserving its original and sibling destinations", () => {
		const initial = structuredClone(DEFAULT_WIZARD_STATE);
		initial.videos = [
			{ height: 1080, bitrate: null, extras: { mode: "PER_TITLE_TEMPLATE" } },
		];
		const first = { ...initial, ...addVodVideo(initial, 0) };
		const state = { ...first, ...addVodVideo(first, 0) };
		const before = buildPlan(state);
		const next = { ...state, ...updateVodVideoHeight(state, 1, 900) };
		const after = buildPlan(next);
		expect(next.videos[1]?.muxing).toMatchObject({
			path: "video/v900/{height}_{bitrate}_{uuid}",
			autoPath: "video/v900/{height}_{bitrate}_{uuid}",
		});
		expect(
			after.muxings.find((row) => row.key === "v900")?.destination?.path,
		).toBe("video/v900/{height}_{bitrate}_{uuid}");
		for (const key of ["v1080", "v1080-3"])
			expect(after.muxings.find((row) => row.key === key)).toEqual(
				before.muxings.find((row) => row.key === key),
			);
		expect(JSON.stringify(after)).not.toContain("autoPath");
	});
	it("keeps a manually edited generated output path when the height changes", () => {
		const state = copiedState();
		copiedVideo(state).muxing.path = "customer/fixed-output";
		const next = { ...state, ...updateVodVideoHeight(state, 1, 900) };
		expect(next.videos[1]?.extras?.key).toBe("v900");
		expect(
			buildPlan(next).muxings.find((row) => row.key === "v900")?.destination
				?.path,
		).toBe("customer/fixed-output");
	});
	it("allocates a free output directory without changing the height key when only the path collides", () => {
		const state = copiedState();
		state.videos.push({
			height: 480,
			bitrate: 800_000,
			extras: { key: "customer" },
			muxing: { path: "video/v900" },
		});
		const next = { ...state, ...updateVodVideoHeight(state, 1, 900) };
		const plan = buildPlan(next);
		expect(next.videos[1]?.extras?.key).toBe("v900");
		expect(
			plan.muxings.find((row) => row.key === "v900")?.destination?.path,
		).toBe("video/v900-2");
		expect(
			plan.muxings.find((row) => row.key === "customer")?.destination?.path,
		).toBe("video/v900");
	});
	it("allocates height keys around collisions in sibling rendition, muxing, thumbnail and source namespaces", () => {
		const state = copiedState();
		state.videos.push({
			height: 900,
			bitrate: 3_000_000,
			extras: { key: "v900" },
			muxing: { key: "v900-2" },
		});
		state.thumbnails = [
			{ key: "v900-3", streamKey: "v1080", height: 180, positions: [0] },
		];
		state.sources = { keyframes: [{ key: "v900-4", time: 1 }] };
		const next = { ...state, ...updateVodVideoHeight(state, 1, 900) };
		expect(next.videos[1]?.extras?.key).toBe("v900-5");
		expect(next.videos[2]?.extras?.key).toBe("v900");
	});
	it("opts a new copy of a conventional imported key into height naming while preserving the imported original", () => {
		const state = copiedState("v1080");
		expect(state.videos[0]?.autoKey).toBeUndefined();
		expect(state.videos[1]?.autoKey).toBe("v1080-2");
		const changedCopy = { ...state, ...updateVodVideoHeight(state, 1, 900) };
		expect(videoKeys(changedCopy.videos)).toEqual(["v1080", "v900"]);
		const changedOriginal = {
			...state,
			...updateVodVideoHeight(state, 0, 720),
		};
		expect(changedOriginal.videos[0]?.extras?.key).toBe("v1080");
	});
	it("preserves copied custom names, manually overridden automatic names and custom muxing names", () => {
		const named = copiedState("customer-main");
		const changedNamed = { ...named, ...updateVodVideoHeight(named, 1, 900) };
		expect(changedNamed.videos[1]?.extras?.key).toBe("customer-main-2");
		expect(changedNamed.videos[1]?.autoKey).toBeUndefined();
		const manual = copiedState();
		copiedVideo(manual).extras.key = "manually-named";
		const changedManual = {
			...manual,
			...updateVodVideoHeight(manual, 1, 900),
		};
		expect(changedManual.videos[1]?.extras?.key).toBe("manually-named");
		const customMux = copiedState();
		const customCopy = copiedVideo(customMux);
		customCopy.muxing.key = "delivery-main";
		customCopy.video.extraMuxings = [{ key: "delivery-archive", kind: "MP4" }];
		customMux.drm = [
			{
				kind: "CENC",
				muxingKey: "delivery-main",
				credentialId: "vault",
				kid: "kid",
			},
		];
		const changedMux = {
			...customMux,
			...updateVodVideoHeight(customMux, 1, 900),
		};
		expect(changedMux.videos[1]?.extras?.key).toBe("v900");
		expect(changedMux.videos[1]?.muxing?.key).toBe("delivery-main");
		expect(changedMux.videos[1]?.extraMuxings?.[0]?.key).toBe(
			"delivery-archive",
		);
		expect(changedMux.drm?.[0]?.muxingKey).toBe("delivery-main");
	});
	it("uses the current height as the base when copying an automatic copy", () => {
		const state = copiedState();
		const third = { ...state, ...addVodVideo(state, 1) };
		expect(videoKeys(third.videos)).toEqual(["v1080", "v1080-2", "v1080-3"]);
		const changed = { ...third, ...updateVodVideoHeight(third, 1, 900) };
		const fourth = { ...changed, ...addVodVideo(changed, 1) };
		expect(fourth.videos[3]?.extras?.key).toBe("v900-2");
		const renamedCopy = { ...fourth, ...updateVodVideoHeight(fourth, 3, 800) };
		expect(
			buildPlan(renamedCopy).muxings.find((row) => row.key === "v800")
				?.destination?.path,
		).toBe("video/v800");
		expect(renamedCopy.videos[1]?.muxing?.path).toBe("video/v900");
	});
	it("clears a template height without retaining the old resolution and restores height naming after draft serialization", () => {
		const state = copiedState();
		const cleared = { ...state, ...updateVodVideoHeight(state, 1, null) };
		expect(cleared.videos[1]?.height).toBeNull();
		expect(cleared.videos[1]?.extras?.key).toBe("video2");
		const restored = JSON.parse(JSON.stringify(cleared)) as WizardState;
		const next = { ...restored, ...updateVodVideoHeight(restored, 1, 720) };
		expect(next.videos[1]?.extras?.key).toBe("v720");
	});
});
