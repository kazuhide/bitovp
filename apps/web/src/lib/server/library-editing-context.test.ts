import { randomUUID } from "node:crypto";
import { hashEditingEvidence, normalizeSceneAnalysis } from "@bitovp/core";
import type {
	AppPrismaClient,
	LibraryMediaVersion,
	SceneAnalysisRevision,
} from "@bitovp/db";
import type { ObjectIdentity } from "@bitovp/storage";
import { describe, expect, it, vi } from "vitest";
import { resolveAutomaticEditingContext } from "./library-editing-context";

function fixture() {
	const organizationId = randomUUID(),
		sourceId = randomUUID(),
		mediaId = randomUUID(),
		analysisId = randomUUID(),
		credentialId = randomUUID();
	const source = {
		id: sourceId,
		organizationId,
		sourceKind: "VOD_JOB",
		encodingId: randomUUID(),
	};
	const output = {
		key: "encoded-mp4",
		kind: "MP4" as const,
		credentialId,
		bucket: "outputs",
		path: "encoding/main.mp4",
	};
	const timeMap = {
		id: mediaId,
		mediaVersionId: mediaId,
		kind: "CFR",
		sourceStartUs: 0,
		sourceEndUs: 2_000_000,
		editingStartFrame: 0,
		editingEndFrame: 60,
		fps: { num: 30, den: 1 },
	};
	const media = {
		id: mediaId,
		sourceId,
		organizationId,
		state: "READY",
		sha256: "a".repeat(64),
		width: 640,
		height: 360,
		timeMap,
		probe: { streams: [{ codec_type: "video" }, { codec_type: "audio" }] },
		storage: {
			source: {
				credentialId,
				bucket: output.bucket,
				key: output.path,
				size: 100,
				expect: { etag: '"encoded"' },
			},
			output: {
				credentialId,
				bucket: output.bucket,
				prefix: "encoding/bitovp-editing/",
			},
		},
	} as unknown as LibraryMediaVersion;
	const raw = {
		metadata: { version: "authored-context-regression" },
		duration: 2,
		scenes: [
			{
				id: randomUUID(),
				type: "MAIN_CONTENT",
				title: "Interview",
				startInSeconds: 0,
				endInSeconds: 2,
				shots: [{ startInSeconds: 0, endInSeconds: 2 }],
			},
		],
	};
	const analysis = {
		id: analysisId,
		sourceId,
		organizationId,
		locale: "en",
		providerVersion: "authored-context-regression",
		createdAt: new Date("2026-11-02T00:00:00Z"),
		raw,
		rawHash: hashEditingEvidence(raw),
		document: normalizeSceneAnalysis(raw),
	} as SceneAnalysisRevision;
	const proof = {
		schemaVersion: 1,
		kind: "FIXTURE_AUTHORED",
		organizationId,
		sourceId,
		locale: "en",
		analysisRevisionId: analysisId,
		analysisRawHash: analysis.rawHash,
		analysisDocumentHash: hashEditingEvidence(analysis.document),
		mediaVersionId: mediaId,
		mediaSha256: media.sha256,
		timeMapId: mediaId,
		timeMapHash: hashEditingEvidence(timeMap),
		sourceStartUs: 0,
		sourceEndUs: 2_000_000,
		width: 640,
		height: 360,
	};
	const bindings = [
		{
			organizationId,
			mediaVersionId: mediaId,
			analysisRevisionId: analysisId,
			proof,
		},
	];
	const findMany = vi.fn(async () => bindings);
	const prisma = {
		libraryAnalysisBinding: { findMany },
	} as unknown as AppPrismaClient;
	return {
		organizationId,
		source,
		outputs: [output],
		output,
		proof,
		mediaVersions: [media],
		analyses: [analysis],
		prisma,
		findMany,
		readOutputIdentity: vi.fn(
			async (): Promise<ObjectIdentity> => ({ size: 100, etag: '"encoded"' }),
		),
		bindings,
		media,
		analysis,
	};
}

describe("encoding-bound automatic editing context", () => {
	it("loads the same encoded output and its verified analysis without a manual selector", async () => {
		const f = fixture(),
			result = await resolveAutomaticEditingContext(f);
		expect(result).toMatchObject({
			encodingId: f.source.encodingId,
			status: "READY",
			mediaVersionId: f.media.id,
			analysisRevisionId: f.analysis.id,
			hasAudio: true,
			reason: null,
		});
		expect(result.preparation).toEqual({
			fileKey: "encoded-mp4",
			output: {
				credentialId: f.outputs[0]?.credentialId,
				bucket: "outputs",
				prefix: "encoding",
			},
		});
	});
	it("prefers an already verified pair over newer unrelated preparation and analysis", async () => {
		const f = fixture();
		f.mediaVersions.unshift({
			...f.media,
			id: randomUUID(),
			sha256: "b".repeat(64),
		});
		f.analyses.unshift({
			...f.analysis,
			id: randomUUID(),
			rawHash: "c".repeat(64),
		});
		await expect(resolveAutomaticEditingContext(f)).resolves.toMatchObject({
			status: "READY",
			mediaVersionId: f.media.id,
			analysisRevisionId: f.analysis.id,
		});
	});
	it("keeps a missing association in the integrated confirmation step", async () => {
		const f = fixture();
		f.bindings.splice(0);
		await expect(resolveAutomaticEditingContext(f)).resolves.toMatchObject({
			status: "NEEDS_CONFIRMATION",
			mediaVersionId: f.media.id,
			analysisRevisionId: f.analysis.id,
			reason: "ANALYSIS_BINDING_UNVERIFIED",
		});
	});
	it("never substitutes a captured original for the requested encoded output", async () => {
		const f = fixture();
		f.media.storage = {
			source: {
				credentialId: f.outputs[0]?.credentialId,
				bucket: "inputs",
				key: "original.mov",
			},
			output: {
				credentialId: f.outputs[0]?.credentialId,
				bucket: "outputs",
				prefix: "editing/",
			},
		};
		await expect(resolveAutomaticEditingContext(f)).resolves.toMatchObject({
			status: "NEEDS_PREPARATION",
			mediaVersionId: null,
		});
		expect(f.findMany).not.toHaveBeenCalled();
	});
	it("reports analysis and source preparation as separate waiting states", async () => {
		const f = fixture();
		f.media.state = "RUNNING";
		await expect(resolveAutomaticEditingContext(f)).resolves.toMatchObject({
			status: "PREPARING",
			mediaVersionId: f.media.id,
			hasAudio: null,
		});
		f.analyses.splice(0);
		await expect(resolveAutomaticEditingContext(f)).resolves.toMatchObject({
			status: "ANALYSIS_PENDING",
			analysisRevisionId: null,
			hasAudio: null,
		});
	});
	it("does not select a foreign source or a mismatched binding as verified", async () => {
		const f = fixture();
		f.source.organizationId = randomUUID();
		await expect(resolveAutomaticEditingContext(f)).resolves.toMatchObject({
			status: "UNAVAILABLE",
			reason: "NO_ENCODING_SOURCE",
		});
		expect(f.findMany).not.toHaveBeenCalled();
	});
	it("reports no output instead of inventing a locator", async () => {
		const f = fixture();
		f.outputs.splice(0);
		await expect(resolveAutomaticEditingContext(f)).resolves.toMatchObject({
			status: "UNAVAILABLE",
			reason: "NO_EDITABLE_OUTPUT",
			preparation: null,
			mediaVersionId: null,
		});
	});
	it("only reports known audio facts from the prepared video probe", async () => {
		const f = fixture();
		f.media.probe = { streams: [{ codec_type: "video" }] };
		await expect(resolveAutomaticEditingContext(f)).resolves.toMatchObject({
			hasAudio: false,
		});
		f.media.probe = {};
		await expect(resolveAutomaticEditingContext(f)).resolves.toMatchObject({
			hasAudio: null,
		});
	});
});

describe("automatic output identity admission", () => {
	it("excludes a captured original pinned to the old version of the encoded output key", async () => {
		const f = fixture();
		f.proof.kind = "CAPTURED_INPUT";
		f.media.storage = {
			...(f.media.storage as object),
			source: {
				credentialId: f.output.credentialId,
				bucket: f.output.bucket,
				key: f.output.path,
				size: 100,
				expect: { etag: '"original"', versionId: "original-version" },
			},
		};
		await expect(resolveAutomaticEditingContext(f)).resolves.toMatchObject({
			status: "NEEDS_PREPARATION",
			mediaVersionId: null,
		});
	});
	it("does not offer the old original for confirmation when it lacks a binding", async () => {
		const f = fixture();
		f.bindings.splice(0);
		f.media.storage = {
			...(f.media.storage as object),
			source: {
				credentialId: f.output.credentialId,
				bucket: f.output.bucket,
				key: f.output.path,
				size: 100,
				expect: { etag: '"original"' },
			},
		};
		await expect(resolveAutomaticEditingContext(f)).resolves.toMatchObject({
			status: "NEEDS_PREPARATION",
			mediaVersionId: null,
		});
	});
	it("reuses an identical actual output even when its association kind is CAPTURED_INPUT", async () => {
		const f = fixture();
		f.proof.kind = "CAPTURED_INPUT";
		await expect(resolveAutomaticEditingContext(f)).resolves.toMatchObject({
			status: "READY",
			mediaVersionId: f.media.id,
		});
	});
	it("fails closed on a failed identity read instead of adopting or reconfirming a locator", async () => {
		const f = fixture();
		f.readOutputIdentity.mockRejectedValue(
			new Error("private upstream detail"),
		);
		await expect(resolveAutomaticEditingContext(f)).resolves.toMatchObject({
			status: "UNAVAILABLE",
			reason: "OUTPUT_IDENTITY_UNVERIFIED",
			mediaVersionId: null,
		});
	});
});

describe("bounded current output checks", () => {
	it("checks a shared output locator once across candidate media", async () => {
		const f = fixture();
		f.mediaVersions.unshift(
			{ ...f.media, id: randomUUID() },
			{ ...f.media, id: randomUUID() },
		);
		await expect(resolveAutomaticEditingContext(f)).resolves.toMatchObject({
			status: "READY",
			mediaVersionId: f.media.id,
		});
		expect(f.readOutputIdentity).toHaveBeenCalledTimes(1);
	});
	it.each([
		{ size: 101, etag: '"encoded"' },
		{ size: 100, etag: '"changed"' },
		{ size: 100, versionId: "encoded-version" },
	])("requires the pinned size and selectors (%j)", async (identity) => {
		const f = fixture();
		f.readOutputIdentity.mockResolvedValue(identity);
		await expect(resolveAutomaticEditingContext(f)).resolves.toMatchObject({
			status: "NEEDS_PREPARATION",
			mediaVersionId: null,
		});
	});
	it("does not equate equal etags across different pinned object versions", async () => {
		const f = fixture();
		f.media.storage = {
			...(f.media.storage as object),
			source: {
				credentialId: f.output.credentialId,
				bucket: f.output.bucket,
				key: f.output.path,
				size: 100,
				expect: { etag: '"encoded"', versionId: "original-version" },
			},
		};
		f.readOutputIdentity.mockResolvedValue({
			size: 100,
			etag: '"encoded"',
			versionId: "output-version",
		});
		await expect(resolveAutomaticEditingContext(f)).resolves.toMatchObject({
			status: "NEEDS_PREPARATION",
			mediaVersionId: null,
		});
	});
	it("caps distinct output identity reads without silently choosing a partial candidate set", async () => {
		const f = fixture();
		const outputs = Array.from({ length: 9 }, (_, index) => ({
			...f.output,
			key: `encoded-${index}`,
			path: `encoded/${index}.mp4`,
		}));
		const mediaVersions = outputs.map((output) => ({
			...f.media,
			id: randomUUID(),
			storage: {
				...(f.media.storage as object),
				source: {
					credentialId: output.credentialId,
					bucket: output.bucket,
					key: output.path,
					size: 100,
					expect: { etag: '"encoded"' },
				},
			},
		}));
		await expect(
			resolveAutomaticEditingContext({ ...f, outputs, mediaVersions }),
		).resolves.toMatchObject({
			status: "UNAVAILABLE",
			reason: "OUTPUT_IDENTITY_LIMIT",
			mediaVersionId: null,
		});
		expect(f.readOutputIdentity).not.toHaveBeenCalled();
	});
});
