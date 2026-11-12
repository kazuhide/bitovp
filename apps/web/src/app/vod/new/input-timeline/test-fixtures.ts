import type {
	VodInputPreviewTask,
	VodInputTimelineSourceFacts,
	VodInputTimelineV1Document,
} from "@bitovp/core/vod-input-timeline";

export const sequenceId = "10000000-0000-4000-8000-000000000001";
export const clipA = "10000000-0000-4000-8000-000000000002";
export const clipB = "10000000-0000-4000-8000-000000000003";
export const splitId = "10000000-0000-4000-8000-000000000004";
export const taskId = "10000000-0000-4000-8000-000000000005";
export const taskB = "10000000-0000-4000-8000-000000000006";
export const credentialId = "10000000-0000-4000-8000-000000000007";
export const organizationId = "00000000-0000-4000-8000-000000000001";

const sourceFact = (key: string): VodInputTimelineSourceFacts => ({
	key,
	durationMs: 60_000,
	video: {
		streamIndex: 0,
		width: 1920,
		height: 1080,
		frameRate: { num: 30_000, den: 1001 },
	},
	audio: { streamIndex: 1, sampleRate: 48_000, channels: 2 },
	identity: { size: 1024, etag: `etag-${key}` },
});
export const facts: [VodInputTimelineSourceFacts, VodInputTimelineSourceFacts] =
	[sourceFact("a"), sourceFact("b")];

export function timeline(): VodInputTimelineV1Document {
	return {
		schemaVersion: 1,
		id: sequenceId,
		audioEnabled: true,
		clips: [
			{ id: clipA, sourceKey: "a", inMs: 10_000, outMs: 20_000 },
			{ id: clipB, sourceKey: "b", inMs: 0, outMs: 15_000 },
		],
	};
}

export function previewTask(
	partial: Partial<VodInputPreviewTask> = {},
): VodInputPreviewTask {
	return {
		id: taskId,
		kind: "PREVIEW",
		status: "SUCCEEDED",
		stage: "READY",
		requestHash: "a".repeat(64),
		createdAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
		result: {
			preview: {
				startMs: 0,
				durationMs: 25_000,
				size: 1024,
				sha256: "b".repeat(64),
			},
		},
		...partial,
	};
}
