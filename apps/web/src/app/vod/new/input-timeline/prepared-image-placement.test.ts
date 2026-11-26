import type { VodInputPreviewResult } from "@bitovp/core/vod-input-timeline";
import { describe, expect, it } from "vitest";
import type { WizardInputFile } from "../build-plan";
import {
	buildPreparedImagePlacement,
	preparedImageFile,
} from "./prepared-image-placement";
import { facts, timeline } from "./test-fixtures";
import {
	createHistory,
	normalizeTimeline,
	timelineAt,
	timelineHistory,
} from "./timeline-state";

const id = "10000000-0000-4000-8000-000000000021";
const credentialId = "10000000-0000-4000-8000-000000000022";
const prepared: NonNullable<VodInputPreviewResult["prepared"]> = {
	source: {
		key: "cover",
		credentialId,
		bucket: "prepared",
		objectKey: "generated/cover.mp4",
	},
	facts: { ...facts[0], key: "cover", durationMs: 6000 },
	requestedDurationMs: 5000,
	sha256: "d".repeat(64),
};
const mainFile: WizardInputFile = {
	key: "main",
	inputKey: "main",
	kind: "S3",
	credentialId,
	bucket: "prepared",
	path: "main.mp4",
};
const files: WizardInputFile[] = [mainFile];
describe("prepared cover placement", () => {
	it("replaces only V1 at the playhead and retains the underlying source clocks and A1", () => {
		const before = normalizeTimeline(timeline());
		let index = 0;
		const next = buildPreparedImagePlacement(
			before,
			prepared,
			{ mode: "overwrite", atMs: 4000 },
			facts,
			() => (index++ === 0 ? id : "10000000-0000-4000-8000-000000000023"),
		);
		expect(next.document.audioClips).toEqual(before.audioClips);
		expect(next.document.durationMs).toBe(before.durationMs);
		expect(next.document.videoClips.find((c) => c.id === id)).toMatchObject({
			sourceKey: "cover",
			startMs: 4000,
			inMs: 0,
			outMs: 5000,
		});
		expect(next.startMs).toBe(4000);
		const following = next.document.videoClips.find((c) => c.startMs === 9000);
		expect(following?.inMs).toBe(timelineAt(before, 9000)?.sourceMs);
		expect(following?.sourceKey).toBe(timelineAt(before, 9000)?.clip.sourceKey);
	});
	it("appends the image and silent audio after the program without altering existing clips", () => {
		const before = normalizeTimeline(timeline());
		const next = buildPreparedImagePlacement(
			before,
			prepared,
			{ mode: "append", atMs: 0 },
			facts,
			() => id,
		);
		expect(next.document.durationMs).toBe(before.durationMs + 5000);
		expect(next.document.videoClips.slice(0, -1)).toEqual(before.videoClips);
		expect(next.document.audioClips.slice(0, -1)).toEqual(before.audioClips);
		expect(next.document.audioClips.at(-1)).toMatchObject({
			id,
			sourceKey: "cover",
			startMs: before.durationMs,
			outMs: 5000,
		});
		const history = timelineHistory(createHistory(before), {
			type: "commit",
			document: next.document,
		});
		expect(timelineHistory(history, { type: "undo" }).present).toEqual(before);
		expect(
			timelineHistory(timelineHistory(history, { type: "undo" }), {
				type: "redo",
			}).present,
		).toEqual(next.document);
	});
	it("does not let overwrite extend beyond the program", () => {
		const before = normalizeTimeline(timeline());
		expect(() =>
			buildPreparedImagePlacement(
				before,
				prepared,
				{ mode: "overwrite", atMs: before.durationMs - 1000 },
				facts,
				() => id,
			),
		).toThrow();
	});
	it("copies a storage reference and display label without retaining the source image capability", () => {
		const copy = preparedImageFile(files, prepared, "S3", "Opening card");
		expect(copy).toEqual({
			key: "cover",
			inputKey: "main",
			kind: "S3",
			credentialId,
			bucket: "prepared",
			path: "generated/cover.mp4",
			displayName: "Opening card",
		});
		expect(files).toHaveLength(1);
	});
	it("refuses a colliding key or a seventeenth media source", () => {
		expect(() =>
			preparedImageFile(
				[{ ...mainFile, key: "cover" }],
				prepared,
				"S3",
				"Card",
			),
		).toThrow();
		expect(() =>
			preparedImageFile(
				Array.from({ length: 16 }, (_, i) => ({
					...mainFile,
					key: `source_${i}`,
				})),
				prepared,
				"S3",
				"Card",
			),
		).toThrow();
	});
});
