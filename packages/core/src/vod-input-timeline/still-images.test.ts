import { describe, expect, it } from "vitest";
import {
	vodInputPreviewRequestSchema,
	vodInputPreviewResultSchema,
	vodInputPreviewSubmissionSchema,
	vodInputPreviewTaskSchema,
} from "./contracts";

const uuid = "00000000-0000-4000-8000-000000000001";
const input = {
	kind: "IMAGE_PREPARE",
	source: {
		key: "cover",
		credentialId: uuid,
		bucket: "input",
		objectKey: "cover.png",
	},
	durationMs: 5000,
	output: { credentialId: uuid, bucket: "output", prefix: "vod-test" },
	sourceIdentity: { size: 100, etag: '"original"' },
};

describe("durable still-image input intent", () => {
	it("accepts a dedicated sealed image intent without changing the timeline wire shape", () => {
		expect(vodInputPreviewRequestSchema.parse(input)).toEqual(input);
		const { sourceIdentity: _sealed, ...submission } = input;
		expect(vodInputPreviewSubmissionSchema.parse(submission)).toEqual(
			submission,
		);
		expect(vodInputPreviewSubmissionSchema.safeParse(input).success).toBe(
			false,
		);
	});
	it("requires bounded duration, a sealed identity and a storage destination", () => {
		for (const durationMs of [999, 60_001, 1000.5])
			expect(
				vodInputPreviewRequestSchema.safeParse({ ...input, durationMs })
					.success,
			).toBe(false);
		for (const sourceIdentity of [
			undefined,
			{ size: 100 },
			{ size: 33 * 1024 ** 2, etag: "x" },
			{ size: 100, versionId: "null" },
		])
			expect(
				vodInputPreviewRequestSchema.safeParse({ ...input, sourceIdentity })
					.success,
			).toBe(false);
		for (const prefix of [
			"../unsafe",
			"folder?query",
			"folder#fragment",
			"bad\u007fpath",
		])
			expect(
				vodInputPreviewRequestSchema.safeParse({
					...input,
					output: { ...input.output, prefix },
				}).success,
			).toBe(false);
		expect(
			vodInputPreviewRequestSchema.safeParse({
				...input,
				output: { ...input.output, bucket: "bad?bucket" },
			}).success,
		).toBe(false);
		expect(
			vodInputPreviewRequestSchema.safeParse({
				...input,
				localPath: "/tmp/input.png",
			}).success,
		).toBe(false);
	});
	it("returns a reusable normal source only after preparation is ready", () => {
		const prepared = {
			source: {
				...input.source,
				key: "img_task",
				bucket: "output",
				objectKey: "owned/task/image.mp4",
			},
			facts: {
				key: "img_task",
				durationMs: 5000,
				video: {
					streamIndex: 0,
					width: 1920,
					height: 1080,
					displayAspectRatio: { num: 16, den: 9 },
				},
				audio: { streamIndex: 1, sampleRate: 48000, channels: 2 },
				identity: { size: 1000, etag: '"ready"' },
			},
			requestedDurationMs: 5000,
			sha256: "a".repeat(64),
		};
		expect(vodInputPreviewResultSchema.parse({ prepared })).toEqual({
			prepared,
		});
		expect(
			vodInputPreviewTaskSchema.safeParse({
				id: uuid,
				kind: "IMAGE_PREPARE",
				status: "SUCCEEDED",
				stage: "READY",
				requestHash: "b".repeat(64),
				createdAt: "2026-11-13T00:00:00.000Z",
				expiresAt: "2026-11-14T00:00:00.000Z",
				result: { prepared },
			}).success,
		).toBe(true);
	});
});
