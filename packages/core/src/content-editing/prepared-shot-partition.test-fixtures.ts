import { normalizeSceneAnalysis } from "../content-library/analysis";
import { hashEditingEvidence } from "./verify-automatic-binding";
export const preparedSceneId = "11111111-1111-4111-8111-111111111111";
export function preparedClockFixture() {
	const source = {
		width: 1600,
		height: 900,
		codec: "h264" as const,
		fps: { num: 24, den: 1 },
		timeBase: { num: 1, den: 90000 },
		frameCount: 48,
		durationUs: 2000000,
		videoPtsHash: "c".repeat(64),
		colorProfile: "BT709_8BIT_LIMITED" as const,
		audio: null,
	};
	const index = Array.from({ length: 60 }, (_, i) => Math.floor((i * 24) / 30));
	const proof = {
		schemaVersion: 1 as const,
		profile: "SDR_CFR30_INDEXED_V1" as const,
		mode: "NORMALIZE" as const,
		originalSha256: "a".repeat(64),
		preparedSha256: "b".repeat(64),
		originalBytes: 1000,
		preparedBytes: 1200,
		source,
		output: {
			width: 1600,
			height: 900,
			frameCount: 60,
			durationUs: 2000000,
			fps: { num: 30 as const, den: 1 as const },
			hasAudio: false,
		},
		sourceStartUs: 0 as const,
		sourceEndUs: 2000000,
		sourceFrameIndex: index,
		indexMapHash: hashEditingEvidence(index),
		recipeHash: hashEditingEvidence({
			profile: "SDR_CFR30_INDEXED_V1",
			mode: "NORMALIZE",
			source,
			videoFilter:
				"fps=fps=30:start_time=0:round=up:eof_action=pass,trim=end_frame=60,setpts=N/(30*TB),setsar=1/1",
			audioFilter: null,
		}),
		organizationId: "00000000-0000-4000-8000-000000000001",
		sourceId: "22222222-2222-4222-8222-222222222222",
		mediaVersionId: "33333333-3333-4333-8333-333333333333",
		timeMapId: "44444444-4444-4444-8444-444444444444",
	};
	const timeMap = {
		id: proof.timeMapId,
		mediaVersionId: proof.mediaVersionId,
		kind: "CFR" as const,
		sourceStartUs: 0,
		sourceEndUs: 2000000,
		editingStartFrame: 0,
		editingEndFrame: 60,
		fps: { num: 30 as const, den: 1 as const },
	};
	const times = [0, 0.041667, 0.083333, 0.125, 0.166667, 2];
	const analysis = normalizeSceneAnalysis({
		metadata: { version: "synthetic-prepared-clock-test" },
		duration: 2,
		scenes: [
			{
				id: preparedSceneId,
				type: "MAIN_CONTENT",
				startInSeconds: 0,
				endInSeconds: 2,
				title: "shared cuts",
				shots: times
					.slice(0, -1)
					.map((s, i) => ({ startInSeconds: s, endInSeconds: times[i + 1] })),
			},
		],
	});
	return {
		proof,
		timeMap,
		analysis,
		verify: {
			proof,
			proofHash: hashEditingEvidence(proof),
			organizationId: proof.organizationId,
			sourceId: proof.sourceId,
			mediaVersionId: proof.mediaVersionId,
			preparedSha256: proof.preparedSha256,
			timeMap,
			width: 1600,
			height: 900,
		},
	};
}

export function fixtureItem<T>(item: T | undefined): T {
	if (item === undefined)
		throw new Error("Required prepared-clock fixture item is missing");
	return item;
}
