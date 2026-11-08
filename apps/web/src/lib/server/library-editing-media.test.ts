import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "./context";

const browserFor = vi.hoisted(() => vi.fn());
const contextState = vi.hoisted(() => ({
	current: null as unknown as ServerContext,
}));
vi.mock("./storage", () => ({ browserForCredentialId: browserFor }));
vi.mock("./context", () => ({
	getServerContext: async () => contextState.current,
}));

import {
	captureEditingIdentity,
	requestEditingMedia,
} from "./library-editing-media";

const source = {
	credentialId: "11111111-1111-4111-8111-111111111111",
	bucket: "private",
	path: "input.mp4",
};
beforeEach(() => {
	browserFor.mockReset();
});
describe("editing source identity capture", () => {
	it.each([
		[404, "SOURCE_FILE_NOT_FOUND"],
		[403, "SOURCE_STORAGE_ACCESS_DENIED"],
	])("classifies upstream %s without exposing diagnostics", async (status, code) => {
		browserFor.mockResolvedValue({
			headObject: async () => {
				throw {
					name: "SDKError",
					message: "secret endpoint",
					$metadata: { httpStatusCode: status },
				};
			},
			dispose: vi.fn(),
		});
		await expect(
			captureEditingIdentity({} as ServerContext, source),
		).rejects.toMatchObject({ code });
	});
	it("does not mistake S3's null version for an immutable version", async () => {
		browserFor.mockResolvedValue({
			headObject: async () => ({ size: 100, versionId: "null" }),
			dispose: vi.fn(),
		});
		await expect(
			captureEditingIdentity({} as ServerContext, source),
		).rejects.toMatchObject({ code: "MEDIA_VERSION_UNVERIFIED" });
	});
	it("captures the exact version and closes storage resources", async () => {
		const dispose = vi.fn();
		browserFor.mockResolvedValue({
			headObject: async () => ({ size: 100, etag: '"opaque"' }),
			dispose,
		});
		expect(await captureEditingIdentity({} as ServerContext, source)).toEqual({
			size: 100,
			etag: '"opaque"',
		});
		expect(dispose).toHaveBeenCalledOnce();
	});
});

describe("derivative editing input", () => {
	const org = "11111111-1111-4111-8111-111111111111";
	const artifactId = "22222222-2222-4222-8222-222222222222";
	const runId = "33333333-3333-4333-8333-333333333333";
	const outputCredential = "44444444-4444-4444-8444-444444444444";
	const file = { key: `render-${artifactId}`, kind: "MP4", ...source };
	const fixedObject = {
		credentialId: source.credentialId,
		bucket: source.bucket,
		key: source.path,
		size: 100,
		expect: { etag: '"fixed-export"', versionId: "fixed-v1" },
	};
	const value = {
		fileKey: file.key,
		output: {
			credentialId: outputCredential,
			bucket: "edits",
			prefix: "safe/",
		},
	};
	function fixture() {
		const snapshot = {
			schemaVersion: 2,
			kind: "DERIVED_RENDER",
			name: "Clip",
			identity: "VERIFIED",
			planHash: "a".repeat(64),
			inputs: [],
			playbackLinks: [],
			fileOutputs: [file],
			renderRunId: runId,
			renderArtifactId: artifactId,
			qcVerdict: null,
		};
		const row = {
			organizationId: org,
			sourceKind: "DERIVED_RENDER",
			renderArtifactId: artifactId,
			jobId: null,
			snapshot,
		};
		const artifact = {
			id: artifactId,
			organizationId: org,
			runId,
			size: 100n,
			storage: structuredClone(fixedObject),
			run: { id: runId, state: "SUCCEEDED", profile: { kind: "EXPORT" } },
		};
		const findSource = vi.fn().mockResolvedValue(row);
		const findArtifact = vi.fn().mockResolvedValue(artifact);
		const create = vi.fn().mockImplementation(async ({ data }) => ({
			...data,
			id: runId,
			state: "PENDING",
			error: null,
			durationUs: null,
			width: null,
			height: null,
			timeMap: null,
		}));
		const headObject = vi.fn();
		const watches = vi.fn().mockResolvedValue([]);
		browserFor.mockImplementation(async (_ctx, credentialId) => {
			if (credentialId !== outputCredential)
				throw new Error("Unexpected source identity refresh");
			return {
				headObject,
				getObject: vi.fn(),
				putObject: vi.fn(),
				dispose: vi.fn(),
			};
		});
		contextState.current = {
			tenant: { organizationId: org },
			prisma: {
				librarySource: { findUnique: findSource },
				renderArtifact: { findFirst: findArtifact },
				libraryMediaVersion: { create },
				watchRule: { findMany: watches },
			},
		} as unknown as ServerContext;
		return { row, artifact, findArtifact, create, headObject, watches };
	}
	it.each([
		"safe/",
		"safe/bitovp-editing/",
		"safe/bitovp-editing/renders/",
	])("refuses generated output that overlaps watched input %s in either direction", async (prefix) => {
		const { watches, create } = fixture();
		watches.mockResolvedValue([{ prefix }]);
		await expect(requestEditingMedia(org, value)).rejects.toMatchObject({
			code: "OUTPUT_WATCHED_INPUT",
		});
		expect(create).not.toHaveBeenCalled();
	});
	it("uses saved derivative expect and size for re-edit preparation without HEAD re-pinning", async () => {
		const { create, headObject } = fixture();
		await requestEditingMedia(org, value);
		expect(create.mock.calls[0]?.[0].data.storage.source).toEqual(fixedObject);
		expect(create.mock.calls[0]?.[0].data.outputCredentialId).toBe(
			outputCredential,
		);
		expect(headObject).not.toHaveBeenCalled();
		expect(
			browserFor.mock.calls.every((call) => call[1] === outputCredential),
		).toBe(true);
	});
	it.each([
		"source-artifact",
		"artifact-path",
		"artifact-tenant",
	])("rejects inconsistent derivative %s before preparation", async (change) => {
		const { row, artifact, create, headObject } = fixture();
		if (change === "source-artifact") row.renderArtifactId = runId;
		if (change === "artifact-path") artifact.storage.key = "replaced.mp4";
		if (change === "artifact-tenant") artifact.organizationId = runId;
		await expect(requestEditingMedia(org, value)).rejects.toMatchObject({
			code: "MEDIA_VERSION_UNVERIFIED",
		});
		expect(create).not.toHaveBeenCalled();
		expect(headObject).not.toHaveBeenCalled();
	});
	it("keeps explicit current identity capture for VOD input", async () => {
		const { row, create, findArtifact } = fixture();
		Object.assign(row, {
			sourceKind: "VOD_JOB",
			renderArtifactId: null,
			snapshot: {
				schemaVersion: 1,
				kind: "VOD_JOB",
				name: "VOD",
				identity: "UNVERIFIED",
				planHash: "hash",
				inputs: [],
				playbackLinks: [],
				fileOutputs: [file],
				qcVerdict: null,
				qcOverriddenAt: null,
			},
		});
		const headObject = vi
			.fn()
			.mockResolvedValue({ size: 100, etag: "current-vod" });
		browserFor.mockResolvedValue({
			headObject,
			getObject: vi.fn(),
			putObject: vi.fn(),
			dispose: vi.fn(),
		});
		await requestEditingMedia(org, value);
		expect(headObject).toHaveBeenCalledWith({
			bucket: source.bucket,
			key: source.path,
		});
		expect(create.mock.calls[0]?.[0].data.storage.source.expect).toEqual({
			etag: "current-vod",
		});
		expect(findArtifact).not.toHaveBeenCalled();
	});
});
