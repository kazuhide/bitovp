import { describe, expect, it } from "vitest";
import { encodingPlanSchema } from "../plan/schema";
import {
	enumerateExistingHlsQcTargets,
	enumerateExistingQcMirrorTargets,
	retainedHlsQcKey,
} from "./targets";

function plan() {
	return encodingPlanSchema.parse({
		planVersion: 1,
		name: "existing Dolby Vision HLS",
		generation: { timing: "POST_ENCODING" },
		bitmovin: { accountId: "00000000-0000-4000-8000-000000000001" },
		inputs: [
			{
				key: "in",
				kind: "S3",
				credentialId: "00000000-0000-4000-8000-000000000002",
				bucket: "input",
			},
		],
		outputs: [
			{
				key: "out",
				kind: "S3",
				credentialId: "00000000-0000-4000-8000-000000000002",
				bucket: "output",
			},
		],
		dolbyStreams: [
			{
				key: "dv",
				kind: "VISION",
				inputKey: "in",
				videoInputPath: "source/video.mxf",
			},
		],
		renditions: [
			{
				key: "v",
				codec: "AV1",
				ingestKey: "dv",
				width: 3840,
				height: 2160,
				bitrate: 8000000,
				rate: 24,
				dynamicRangeFormat: "DOLBY_VISION_PROFILE_10_1",
				pixelFormat: "YUV420P10LE",
			},
		],
		muxings: [
			{
				key: "fmp4",
				kind: "FMP4",
				streamKey: "v",
				segmentLength: 2,
				segmentNaming: "seg_%number%.m4s",
				initSegmentName: "init.mp4",
				destination: { outputKey: "out", path: "run/video/" },
			},
		],
		manifests: [
			{
				key: "hls",
				kind: "HLS",
				destination: { outputKey: "out", path: "run/" },
				manifestName: "stream.m3u8",
			},
		],
	});
}

describe("existing full-source HLS QC targets", () => {
	it.each([
		"AUTO",
		"VIDEO_RELATIVE",
	] as const)("uses HDR10+ video, never its JSON metadata, as the %s QC reference", (selectionMode) => {
		const source = plan();
		const p = encodingPlanSchema.parse({
			...source,
			dolbyStreams: [],
			hdr10PlusStreams: [
				{
					key: "hdr10plus",
					inputKey: "in",
					videoInputPath: "source/hdr10.mov",
					metadataInputPath: "source/hdr10plus.json",
					selectionMode,
				},
			],
			renditions: [
				{
					...source.renditions[0],
					codec: "H265",
					ingestKey: "hdr10plus",
					dynamicRangeFormat: "HDR10",
				},
			],
		});
		expect(enumerateExistingHlsQcTargets(p)[0]?.reference).toEqual({
			inputKey: "in",
			inputPath: "source/hdr10.mov",
		});
		const hdr = p.hdr10PlusStreams[0];
		if (!hdr) throw new Error("Missing HDR10+ fixture");
		hdr.selectionMode = "VIDEO_RELATIVE";
		hdr.position = 1;
		expect(enumerateExistingHlsQcTargets(p)).toEqual([]);
		hdr.selectionMode = "POSITION_ABSOLUTE";
		hdr.position = 0;
		expect(enumerateExistingHlsQcTargets(p)).toEqual([]);
	});

	it("resolves embedded Dolby video only through the explicit HLS path", () => {
		const p = plan();
		const before = JSON.stringify(p);
		const [target] = enumerateExistingHlsQcTargets(p);
		expect(target).toMatchObject({
			renditionKey: "v",
			reference: { inputKey: "in", inputPath: "source/video.mxf" },
			distorted: { outputKey: "out", path: "run/stream.m3u8" },
			hls: {
				muxingKey: "fmp4",
				rootPrefix: "run/",
				outputPrefix: "run/video/",
				initKey: "run/video/init.mp4",
			},
		});
		expect(enumerateExistingQcMirrorTargets(p)).toEqual([]);
		expect(JSON.stringify(p)).toBe(before);
	});
	it("derives a job-owned retained key and rejects invalid identifiers", () => {
		const [target] = enumerateExistingHlsQcTargets(plan());
		if (!target) throw new Error("Missing fixture target");
		expect(
			retainedHlsQcKey(
				target,
				"00000000-0000-4000-8000-000000000003",
				"a".repeat(64),
			),
		).toBe(
			`run/video/qc-retained/00000000-0000-4000-8000-000000000003/v-${"a".repeat(64)}.mp4`,
		);
		expect(
			retainedHlsQcKey(
				target,
				"00000000-0000-4000-8000-000000000003",
				"a".repeat(64),
			),
		).not.toBe(
			retainedHlsQcKey(
				target,
				"00000000-0000-4000-8000-000000000003",
				"b".repeat(64),
			),
		);
		expect(() =>
			retainedHlsQcKey(target, "../other", "a".repeat(64)),
		).toThrow();
		expect(() =>
			retainedHlsQcKey(
				target,
				"00000000-0000-4000-8000-000000000003",
				"../other",
			),
		).toThrow();
	});
	it.each([
		"trim",
		"filter",
		"ambiguous",
		"drm",
		"per-title",
		"profile-10-0",
		"unsafe-prefix",
		"template",
	])("refuses %s without shrinking an output population", (shape) => {
		const p = plan();
		if (shape === "trim")
			p.trimmingStreams.push({
				key: "trim",
				kind: "TIME_BASED",
				sourceKey: "dv",
				offset: 1,
				duration: 2,
			});
		if (shape === "filter")
			p.renditions[0] = {
				...p.renditions[0],
				filters: [{ filterKey: "filter", position: 0 }],
			} as (typeof p.renditions)[number];
		if (shape === "ambiguous")
			p.muxings.push({
				...p.muxings[0],
				key: "other",
			} as (typeof p.muxings)[number]);
		if (shape === "drm")
			p.manifests[0] = {
				...p.manifests[0],
				drmKind: "FAIRPLAY",
			} as (typeof p.manifests)[number];
		if (shape === "per-title")
			p.renditions[0] = {
				...p.renditions[0],
				mode: "PER_TITLE_TEMPLATE",
				height: null,
				bitrate: null,
			} as (typeof p.renditions)[number];
		if (shape === "profile-10-0")
			p.renditions[0] = {
				...p.renditions[0],
				dynamicRangeFormat: "DOLBY_VISION_PROFILE_10_0",
			} as (typeof p.renditions)[number];
		if (shape === "unsafe-prefix")
			p.muxings[0] = {
				...p.muxings[0],
				destination: { outputKey: "out", path: "../other/" },
			} as (typeof p.muxings)[number];
		if (shape === "template")
			p.muxings[0] = {
				...p.muxings[0],
				segmentNamingTemplate: "random_%number%.m4s",
			} as (typeof p.muxings)[number];
		expect(enumerateExistingHlsQcTargets(p)).toEqual([]);
	});
	it("requires the complete single video population and a direct first source", () => {
		const p = plan();
		p.renditions.push({
			...p.renditions[0],
			key: "other",
		} as (typeof p.renditions)[number]);
		expect(enumerateExistingHlsQcTargets(p)).toEqual([]);
	});
});
