import {
	compileLiveChannel,
	liveChannelPlanSchema,
	validateLiveChannel,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
	type LiveWizardState,
} from "./build-live-plan";
import { evaluateLiveWizardState } from "./live-plan-preview";
import { tryImportLiveChannelIntoWizard } from "./live-plan-to-wizard";

function state(): LiveWizardState {
	const value = structuredClone(DEFAULT_LIVE_WIZARD_STATE);
	value.name = "Live options";
	value.inputKind = "SRT";
	value.output = {
		...value.output,
		credentialId: "00000000-0000-4000-8000-000000000002",
		bucket: "media",
		basePath: "live",
	};
	value.start.streamKey = "liveStream";
	return value;
}

function first<T>(items: T[]): T {
	const value = items[0];
	if (!value) throw new Error("Missing fixture");
	return value;
}

describe("Live rendition input and storage options", () => {
	it("keeps the unconfigured input and raw muxing defaults unchanged", () => {
		const raw = buildLiveChannelPlan(state());
		expect(raw.ingest).toEqual([
			{ key: "video", inputPath: "/", position: 0 },
			{ key: "audio", inputPath: "/", position: 1 },
		]);
		expect(first(raw.muxings)).toEqual({
			key: "v720",
			kind: "FMP4",
			streamKey: "v720",
			segmentLength: 6,
			destination: { outputKey: "origin", path: "live/video/720p" },
		});
	});

	it("selects separate input tracks without requiring resource keys", () => {
		const value = state();
		first(value.videos).input = { position: 2, inputPath: "/video" };
		first(value.audios).input = { position: 3, inputPath: "/audio" };
		value.audios.push({ codec: "AAC", bitrate: 64000, rate: 48000 });
		const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(value));
		const selections = new Map(plan.ingest.map((entry) => [entry.key, entry]));
		expect(selections.get(first(plan.renditions).ingestKey)).toMatchObject({
			position: 2,
			inputPath: "/video",
		});
		expect(plan.renditions[1]?.ingestKey).not.toBe(
			plan.renditions[2]?.ingestKey,
		);
		const streams = compileLiveChannel(plan).filter(
			(op) => op.kind === "CREATE_STREAM",
		);
		expect(streams.map((op) => op.payload.position)).toEqual([2, 3, 1]);
		expect(streams.map((op) => op.payload.inputPath)).toEqual([
			"/video",
			"/audio",
			"/",
		]);
		const imported = tryImportLiveChannelIntoWizard(plan);
		expect(imported.ok).toBe(true);
		if (!imported.ok) throw new Error("Import refused");
		expect(
			liveChannelPlanSchema.parse(buildLiveChannelPlan(imported.state)),
		).toEqual(plan);
	});

	it("preserves imported shared input references and resource order", () => {
		const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(state()));
		plan.ingest = [
			{ key: "sound", inputPath: "/contribution", position: 4 },
			{ key: "picture", inputPath: "/contribution", position: 2 },
		];
		for (const rendition of plan.renditions)
			rendition.ingestKey = rendition.codec === "AAC" ? "sound" : "picture";
		const imported = tryImportLiveChannelIntoWizard(plan);
		expect(imported.ok).toBe(true);
		if (!imported.ok) throw new Error("Import refused");
		expect(
			liveChannelPlanSchema.parse(buildLiveChannelPlan(imported.state)),
		).toEqual(plan);
	});

	it("round-trips custom media filenames and paths through manifest references", () => {
		const value = state();
		first(value.videos).muxing = {
			path: "delivery/picture",
			segmentNamingTemplate: "video_{rand_chars:8}_%number%.m4s",
			initSegmentName: "video-init.mp4",
		};
		first(value.audios).muxing = {
			path: "delivery/sound",
			segmentNaming: "audio_%number%.m4s",
			initSegmentName: "audio-init.mp4",
		};
		const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(value));
		expect(
			validateLiveChannel(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		const operations = compileLiveChannel(plan);
		const video = operations.find((op) => op.step === "muxing:v720");
		expect(video?.payload).toMatchObject({
			segmentNamingTemplate: "video_{rand_chars:8}_%number%.m4s",
			initSegmentName: "video-init.mp4",
			outputPath: "delivery/picture",
		});
		expect(video?.payload).not.toHaveProperty("segmentNaming");
		expect(
			operations.find((op) => op.kind === "CREATE_HLS_STREAM_INFO")?.payload
				.segmentPath,
		).toBe("../delivery/picture");
		const imported = tryImportLiveChannelIntoWizard(plan);
		expect(imported.ok).toBe(true);
		if (!imported.ok) throw new Error("Import refused");
		expect(
			liveChannelPlanSchema.parse(buildLiveChannelPlan(imported.state)),
		).toEqual(plan);
	});

	it.each([
		"part_%number%.mp4",
		"video_%number%.cmfv",
		"audio_%number%.cmfa",
		"segment_%number%",
	])("accepts a safe segment pattern %s without prescribing an extension", (segmentNaming) => {
		const value = state();
		first(value.videos).muxing = {
			segmentNaming,
			initSegmentName: "bootstrap.m4s",
		};
		const evaluation = evaluateLiveWizardState(value);
		expect(evaluation.ok).toBe(true);
		if (!evaluation.ok) throw new Error(evaluation.zodMessage);
		expect(
			evaluation.issues.filter((issue) => issue.level === "error"),
		).toEqual([]);
		const imported = tryImportLiveChannelIntoWizard(evaluation.plan);
		expect(imported.ok).toBe(true);
		if (!imported.ok) throw new Error("Import refused");
		expect(imported.state.videos[0]?.muxing).toMatchObject({
			segmentNaming,
			initSegmentName: "bootstrap.m4s",
		});
	});

	it("keeps a template-only choice effective after schema defaults and form import", () => {
		const value = state();
		const segmentNamingTemplate = "part_{rand_chars:8}_%number%.mp4";
		first(value.videos).muxing = { segmentNamingTemplate };
		const raw = buildLiveChannelPlan(value);
		expect(first(raw.muxings)).not.toHaveProperty("segmentNaming");
		const plan = liveChannelPlanSchema.parse(raw);
		expect(first(plan.muxings)).toMatchObject({
			segmentNaming: "segment_%number%.m4s",
			segmentNamingTemplate,
		});
		const imported = tryImportLiveChannelIntoWizard(plan);
		expect(imported.ok).toBe(true);
		if (!imported.ok) throw new Error("Import refused");
		expect(imported.state.videos[0]?.muxing).toEqual({ segmentNamingTemplate });
		const evaluation = evaluateLiveWizardState(imported.state);
		expect(evaluation.ok).toBe(true);
		if (!evaluation.ok) throw new Error(evaluation.zodMessage);
		expect(
			evaluation.issues.filter((issue) => issue.level === "error"),
		).toEqual([]);
		const payload = evaluation.ops.find(
			(operation) => operation.step === "muxing:v720",
		)?.payload;
		expect(payload).toHaveProperty(
			"segmentNamingTemplate",
			segmentNamingTemplate,
		);
		expect(payload).not.toHaveProperty("segmentNaming");
	});

	it("keeps provider-valid random-only templates available for encoding", () => {
		const value = state();
		const segmentNamingTemplate = "seg_{segment_rand_chars:8}.mp4";
		first(value.videos).muxing = { segmentNamingTemplate };
		const evaluation = evaluateLiveWizardState(value);
		expect(evaluation.ok).toBe(true);
		if (!evaluation.ok) throw new Error(evaluation.zodMessage);
		expect(
			evaluation.issues.filter((issue) => issue.level === "error"),
		).toEqual([]);
		expect(
			evaluation.ops.find((operation) => operation.step === "muxing:v720")
				?.payload,
		).toHaveProperty("segmentNamingTemplate", segmentNamingTemplate);
	});

	it.each([
		{ path: "../outside" },
		{ path: "folder/%2e%2e/other" },
		{ segmentNaming: "../segment_%number%.m4s" },
		{ segmentNaming: "same.m4s" },
		{ segmentNaming: "video_%unknown%.m4s" },
		{
			segmentNaming: "v_%number%.m4s",
			segmentNamingTemplate: "v_{rand_chars:8}_%number%.m4s",
		},
		{ initSegmentName: "../init.mp4" },
	])("refuses unsafe or conflicting media options %j", (muxing) => {
		const value = state();
		first(value.videos).muxing = muxing;
		expect(() => buildLiveChannelPlan(value)).not.toThrow();
		expect(evaluateLiveWizardState(value).ok).toBe(false);
	});

	it("refuses a custom path colliding with another rendition", () => {
		const value = state();
		first(value.videos).muxing = { path: "live/audio/128000" };
		expect(evaluateLiveWizardState(value)).toMatchObject({
			ok: false,
			zodMessage: expect.stringMatching(/folder|path/i),
		});
	});

	it("reserves custom init files against manifests on the same physical output", () => {
		const value = state();
		first(value.videos).muxing = {
			path: "live",
			initSegmentName: "picture-init.mp4",
		};
		value.manifests.hls.manifestName = "picture-init.mp4";
		const evaluation = evaluateLiveWizardState(value);
		expect(evaluation.ok).toBe(true);
		if (!evaluation.ok) throw new Error("Fixture did not parse");
		expect(evaluation.ops).toEqual([]);
		expect(evaluation.issues).toContainEqual(
			expect.objectContaining({
				code: "LIVE_OUTPUT_NAMESPACE_COLLISION",
				level: "error",
			}),
		);
	});

	it("does not silently ignore init names on TS or storage options on bundled audio", () => {
		const value = state();
		first(value.videos).container = "TS";
		first(value.videos).muxing = { initSegmentName: "init.mp4" };
		expect(evaluateLiveWizardState(value)).toMatchObject({
			ok: false,
			zodMessage: expect.stringMatching(/fMP4/i),
		});
		delete first(value.videos).muxing;
		first(value.videos).muxedAudioKeys = ["a128"];
		first(value.audios).ownContainer = false;
		first(value.audios).muxing = { path: "live/sound" };
		expect(evaluateLiveWizardState(value)).toMatchObject({
			ok: false,
			zodMessage: expect.stringMatching(/container/i),
		});
	});

	it("preserves MSL automatic naming by rejecting custom storage options", () => {
		const value = state();
		value.output.kind = "AKAMAI_MSL";
		value.output.mslStreamFormat = "HLS";
		first(value.videos).muxing = { path: "custom" };
		expect(evaluateLiveWizardState(value)).toMatchObject({
			ok: false,
			zodMessage: expect.stringMatching(/storage/i),
		});
	});
});
