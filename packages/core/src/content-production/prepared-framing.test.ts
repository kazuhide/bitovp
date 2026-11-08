import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildPreparedShotPartition } from "../content-editing/prepared-shot-partition";
import { normalizeSceneAnalysis } from "../content-library/analysis";
import { authoredNormalizationReceipt } from "../testing/normalization-clock";
import { preparedShotFraming } from "./prepared-framing";

function fixture() {
	const organizationId = randomUUID(),
		sourceId = randomUUID(),
		mediaVersionId = randomUUID(),
		sceneId = randomUUID();
	const normalization = authoredNormalizationReceipt({
		organizationId,
		sourceId,
		mediaVersionId,
		sourceFrameCount: 48,
	});
	const analysis = normalizeSceneAnalysis({
		metadata: { version: "authored-prepared-framing-regression" },
		duration: 2,
		scenes: [
			{
				id: sceneId,
				type: "MAIN_CONTENT",
				title: "Cut",
				startInSeconds: 0,
				endInSeconds: 2,
				shots: [
					[0, 0.166667],
					[0.166667, 2],
				].map(([startInSeconds, endInSeconds]) => ({
					startInSeconds,
					endInSeconds,
					mainSubjects: [],
				})),
			},
		],
	});
	const timeMap = {
		id: mediaVersionId,
		mediaVersionId,
		kind: "CFR",
		sourceStartUs: 0,
		sourceEndUs: 2_000_000,
		editingStartFrame: 0,
		editingEndFrame: 60,
		fps: { num: 30, den: 1 },
	};
	return {
		partition: buildPreparedShotPartition({ analysis, timeMap, normalization }),
		sceneId,
		shotIndex: 1,
		fromFrame: 5,
		durationFrames: 55,
		proposal: { mode: "CROP" as const, rect: { x: 0.25, y: 0, w: 0.5, h: 1 } },
	};
}

describe("prepared cut framing", () => {
	it("keeps the uncertain prefix frame as FIT and crops only the certain shot interior", () => {
		const f = fixture(),
			result = preparedShotFraming(f);
		expect(result).toEqual([
			{ fromFrame: 0, toFrame: 1, origin: "AUTO_POLICY", mode: "FIT" },
			{
				fromFrame: 1,
				toFrame: 55,
				origin: "AUTO_POLICY",
				mode: "CROP",
				rect: f.proposal.rect,
			},
		]);
		expect(
			result.reduce((sum, part) => sum + part.toFrame - part.fromFrame, 0),
		).toBe(f.durationFrames);
	});
	it("clips a guard band to the requested source window without moving any frames", () => {
		const f = fixture();
		expect(preparedShotFraming({ ...f, durationFrames: 1 })).toEqual([
			{ fromFrame: 0, toFrame: 1, origin: "AUTO_POLICY", mode: "FIT" },
		]);
		expect(
			preparedShotFraming({ ...f, fromFrame: 6, durationFrames: 10 }),
		).toEqual([
			{
				fromFrame: 0,
				toFrame: 10,
				origin: "AUTO_POLICY",
				mode: "CROP",
				rect: f.proposal.rect,
			},
		]);
	});
	it("rejects a clip outside its verified shot and a serialized imitation of a partition", () => {
		const f = fixture();
		expect(() => preparedShotFraming({ ...f, fromFrame: 4 })).toThrow();
		expect(() =>
			preparedShotFraming({ ...f, sceneId: randomUUID() }),
		).toThrow();
		expect(() =>
			preparedShotFraming({ ...f, partition: structuredClone(f.partition) }),
		).toThrow();
	});
	it("keeps the legacy single-span crop when no prepared clock was recorded", () => {
		const f = fixture();
		expect(preparedShotFraming({ ...f, partition: undefined })).toEqual([
			{
				fromFrame: 0,
				toFrame: 55,
				origin: "AUTO_POLICY",
				mode: "CROP",
				rect: f.proposal.rect,
			},
		]);
	});
});
