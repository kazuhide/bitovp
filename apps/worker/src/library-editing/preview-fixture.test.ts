import {
	librarySourceSnapshotSchema,
	normalizeSceneAnalysis,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	PREVIEW_CONTENT_ID,
	PREVIEW_FIXTURE_VERSION,
	PREVIEW_OBJECT_KEY,
	PREVIEW_REGISTRATION_KEY,
	PREVIEW_SOURCE_ID,
	previewAnalysis,
	previewMediaArguments,
	previewSeedEnvironment,
	previewSourceSnapshot,
} from "./preview-fixture";

const env = {
	BITOVP_EDITING_PREVIEW: "1",
	DATABASE_URL:
		"postgresql://bitovp_runtime:local@postgres:5432/bitovp_editing_preview",
	EDITING_PREVIEW_S3_ACCESS_KEY: "preview-access",
	EDITING_PREVIEW_S3_SECRET_KEY: "preview-secret",
};

describe("editing preview seed boundary", () => {
	it("accepts only the isolated preview database and fixed internal storage", () => {
		expect(previewSeedEnvironment(env)).toEqual({
			endpoint: "http://storage:8333",
			bucket: "bitovp-editing-preview",
			accessKeyId: "preview-access",
			secretAccessKey: "preview-secret",
		});
	});
	it.each([
		{ BITOVP_EDITING_PREVIEW: undefined },
		{ BITOVP_EDITING_PREVIEW: "true" },
		{ DATABASE_URL: "postgresql://bitovp_runtime:local@postgres:5432/bitovp" },
		{
			DATABASE_URL:
				"postgresql://bitovp_runtime:local@production.example/bitovp_editing_preview",
		},
		{
			DATABASE_URL:
				"postgresql://postgres:local@postgres:5432/bitovp_editing_preview",
		},
		{ DATABASE_URL: "not-a-url" },
		{ EDITING_PREVIEW_S3_ACCESS_KEY: "" },
		{ EDITING_PREVIEW_S3_SECRET_KEY: undefined },
	])("rejects an unsafe or incomplete seed environment: %j", (change) => {
		expect(() => previewSeedEnvironment({ ...env, ...change })).toThrow(
			"PREVIEW_ENVIRONMENT_REQUIRED",
		);
	});
});

describe("synthetic preview content", () => {
	it("provides three adjacent six-second scenes with explicit synthetic provenance", () => {
		const raw = previewAnalysis();
		const analysis = normalizeSceneAnalysis(raw);
		expect(analysis.duration).toBe(18);
		expect(
			analysis.scenes.map((scene) => [
				scene.startInSeconds,
				scene.endInSeconds,
			]),
		).toEqual([
			[0, 6],
			[6, 12],
			[12, 18],
		]);
		expect(
			analysis.scenes
				.flatMap((scene) => scene.shots)
				.flatMap((shot) => shot.mainSubjects)
				.map((subject) => subject.centerX),
		).toEqual([20, 80, 50]);
		expect(JSON.stringify(raw)).toContain("合成");
		expect(JSON.stringify(raw)).not.toMatch(
			/transcript|speakerId|trackingId|boundingBox/,
		);
	});
	it("registers a valid authenticated MP4 source without claiming analysis-byte verification", () => {
		const id = "a04e1514-6285-4ea5-9cdc-79dd110f650a";
		const snapshot = librarySourceSnapshotSchema.parse(
			previewSourceSnapshot(id),
		);
		expect(snapshot.identity).toBe("UNVERIFIED");
		expect(snapshot.fileOutputs).toEqual([
			{
				key: "mp4:editing-preview",
				kind: "MP4",
				credentialId: id,
				bucket: "bitovp-editing-preview",
				path: "fixtures/v2/aisa-demo.mp4",
			},
		]);
		expect(snapshot.playbackLinks[0]).toMatchObject({
			via: "AUTHENTICATED",
			url: null,
		});
	});
	it("uses separate stable identifiers so reseeding can preserve the same Library entry", () => {
		expect(PREVIEW_CONTENT_ID).toMatch(/^[0-9a-f-]{36}$/);
		expect(PREVIEW_SOURCE_ID).toMatch(/^[0-9a-f-]{36}$/);
		expect(PREVIEW_CONTENT_ID).not.toBe(PREVIEW_SOURCE_ID);
	});
	it("versions corrected media additively without reusing the invalid v1 identities", () => {
		expect(PREVIEW_FIXTURE_VERSION).toBe("v2");
		expect(PREVIEW_OBJECT_KEY).toBe("fixtures/v2/aisa-demo.mp4");
		expect(PREVIEW_REGISTRATION_KEY).toBe("editing-preview:synthetic:v2");
		expect(PREVIEW_CONTENT_ID).not.toBe("72b10340-2426-439e-8029-3e5dc764ee01");
		expect(PREVIEW_SOURCE_ID).not.toBe("72b10340-2426-439e-8029-3e5dc764ee02");
		expect(previewAnalysis().metadata.version).toBe("synthetic-preview-v2");
	});
	it("pins BT709 in the encoded H264 VUI, beyond generic FFmpeg output metadata", () => {
		const args = previewMediaArguments("/tmp/owned fixture.mp4");
		expect(args[args.indexOf("-x264-params") + 1]).toBe(
			"colorprim=bt709:transfer=bt709:colormatrix=bt709",
		);
		expect(args[args.indexOf("-t") + 1]).toBe("18");
		expect(args.at(-1)).toBe("/tmp/owned fixture.mp4");
	});
});
