import { describe, expect, it } from "vitest";
import {
	type VodInputTimelineDocument,
	type VodInputTimelineSourceFacts,
	vodInputPreviewRequestSchema,
	vodInputTimelineDocumentSchema,
} from "./contracts";
import {
	getVodInputTimelineDurationMs,
	locateVodInputTimelineTime,
	sliceVodInputTimeline,
	validateVodInputTimeline,
} from "./model";

const document: VodInputTimelineDocument = {
	schemaVersion: 1,
	id: "00000000-0000-4000-8000-000000000001",
	audioEnabled: true,
	clips: [
		{
			id: "00000000-0000-4000-8000-000000000002",
			sourceKey: "a",
			inMs: 1000,
			outMs: 3000,
		},
		{
			id: "00000000-0000-4000-8000-000000000003",
			sourceKey: "b",
			inMs: 0,
			outMs: 2000,
		},
		{
			id: "00000000-0000-4000-8000-000000000004",
			sourceKey: "a",
			inMs: 0,
			outMs: 1000,
		},
	],
};
const facts: VodInputTimelineSourceFacts[] = ["a", "b"].map((key) => ({
	key,
	durationMs: 4000,
	video: { streamIndex: 0, width: 1920, height: 1080 },
	audio: { streamIndex: 1, sampleRate: 48000, channels: 2 },
	identity: { size: 100, etag: '"v1"' },
}));

describe("VOD input timeline model", () => {
	it("maps half-open cuts to the next clip without leaking a preceding source time", () => {
		expect(getVodInputTimelineDurationMs(document)).toBe(5000);
		expect(locateVodInputTimelineTime(document, 1999)).toMatchObject({
			clipIndex: 0,
			sourceMs: 2999,
		});
		expect(locateVodInputTimelineTime(document, 2000)).toMatchObject({
			clipIndex: 1,
			sourceMs: 0,
		});
		expect(locateVodInputTimelineTime(document, 5000)).toBeNull();
	});
	it("selects only the intersection of a preview window across repeated sources", () => {
		const sliced = sliceVodInputTimeline(document, {
			startMs: 1500,
			durationMs: 3000,
		});
		expect(
			sliced.videoClips.map(({ sourceKey, inMs, outMs }) => ({
				sourceKey,
				inMs,
				outMs,
			})),
		).toEqual([
			{ sourceKey: "a", inMs: 2500, outMs: 3000 },
			{ sourceKey: "b", inMs: 0, outMs: 2000 },
			{ sourceKey: "a", inMs: 0, outMs: 500 },
		]);
		expect(getVodInputTimelineDurationMs(sliced)).toBe(3000);
		expect(sliced.audioClips).toEqual(sliced.videoClips);
		expect(document.clips[0]?.inMs).toBe(1000);
	});
	it("rejects missing, out-of-bounds and silent sources when linked audio is enabled", () => {
		expect(validateVodInputTimeline(document, facts)).toEqual([]);
		expect(
			validateVodInputTimeline(document, facts.slice(0, 1)).map(
				(issue) => issue.code,
			),
		).toContain("SOURCE_NOT_READY");
		expect(
			validateVodInputTimeline(
				document,
				facts.map((fact) => ({ ...fact, durationMs: 1500 })),
			).map((issue) => issue.code),
		).toContain("SOURCE_RANGE_INVALID");
		const silent = facts.map((fact) => ({ ...fact, audio: null }));
		expect(
			validateVodInputTimeline(document, silent).map((issue) => issue.code),
		).toContain("SOURCE_AUDIO_MISSING");
		expect(
			validateVodInputTimeline({ ...document, audioEnabled: false }, silent),
		).toEqual([]);
	});
	it("rejects duplicate IDs, noninteger times and caller-supplied arbitrary media URLs", () => {
		expect(
			vodInputTimelineDocumentSchema.safeParse({
				...document,
				clips: [document.clips[0], document.clips[0]],
			}).success,
		).toBe(false);
		expect(
			vodInputTimelineDocumentSchema.safeParse({
				...document,
				clips: [{ ...document.clips[0], inMs: 0.1 }],
			}).success,
		).toBe(false);
		expect(
			vodInputPreviewRequestSchema.safeParse({
				kind: "PROBE",
				sources: [
					{
						key: "a",
						credentialId: document.id,
						bucket: "bucket",
						objectKey: "a.mov",
						url: "http://example.invalid/a",
					},
				],
			}).success,
		).toBe(false);
	});
});
