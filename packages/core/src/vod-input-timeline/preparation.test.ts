import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	MAX_VOD_INPUT_PREPARATION_DURATION_MS,
	vodInputPreviewRequestSchema,
	vodInputPreviewResultSchema,
} from "./contracts";

const document = {
	schemaVersion: 2 as const,
	id: randomUUID(),
	audioEnabled: true,
	durationMs: 240_000,
	videoClips: [
		{ id: randomUUID(), sourceKey: "v", startMs: 0, inMs: 0, outMs: 240_000 },
	],
	audioClips: [
		{
			id: randomUUID(),
			sourceKey: "a",
			startMs: 0,
			inMs: 8_000,
			outMs: 248_000,
		},
	],
};
const request = {
	kind: "TIMELINE_PREPARE",
	probeId: randomUUID(),
	document,
	output: { credentialId: randomUUID(), bucket: "output", prefix: "edited/" },
};

describe("durable full quality timeline preparation", () => {
	it("does not apply the 180 second preview range limit to complete programs", () => {
		expect(vodInputPreviewRequestSchema.parse(request)).toEqual(request);
		expect(MAX_VOD_INPUT_PREPARATION_DURATION_MS).toBe(3_600_000);
	});
	it("rejects over-limit programs and unsafe upload prefixes before any work", () => {
		expect(
			vodInputPreviewRequestSchema.safeParse({
				...request,
				document: { ...document, durationMs: 3_600_001 },
			}).success,
		).toBe(false);
		expect(
			vodInputPreviewRequestSchema.safeParse({
				...request,
				output: { ...request.output, prefix: "../escape" },
			}).success,
		).toBe(false);
	});
	it("does not accept an editor-provided output version as prepared evidence", () => {
		expect(
			vodInputPreviewRequestSchema.safeParse({
				...request,
				outputIdentity: { size: 100, etag: "client" },
			}).success,
		).toBe(false);
	});
	it("requires the preparation result to include full source and provenance evidence", () => {
		expect(
			vodInputPreviewResultSchema.safeParse({
				preparation: { sha256: "a".repeat(64) },
			}).success,
		).toBe(false);
	});
});
