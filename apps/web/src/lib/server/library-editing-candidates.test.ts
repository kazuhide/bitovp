import { randomUUID } from "node:crypto";
import { hashEditingEvidence, normalizeSceneAnalysis } from "@bitovp/core";
import type {
	AppPrismaClient,
	LibraryMediaVersion,
	SceneAnalysisRevision,
} from "@bitovp/db";
import type { ObjectIdentity } from "@bitovp/storage";
import { afterEach, expect, it, vi } from "vitest";
import type { ServerContext } from "./context";

const state = vi.hoisted(() => ({
	context: {} as ServerContext,
	browser: vi.fn(),
}));
vi.mock("./context", () => ({ getServerContext: async () => state.context }));
vi.mock("./storage", () => ({ browserForCredentialId: state.browser }));

import {
	loadAutomaticEditingCandidates,
	readAutomaticEditingOutputIdentity,
} from "./library-editing-candidates";
import { editingEligibility } from "./library-editing-media";

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
		readOutputIdentity: vi.fn(async () => ({ size: 100, etag: '"encoded"' })),
		bindings,
		media,
		analysis,
	};
}

it("reuses a bound READY pair beyond both displayed histories and includes the chosen IDs for the UI", async () => {
	const f = fixture();
	Object.assign(f.media, { error: null, durationUs: 2_000_000n });
	const rows = [
		...Array.from({ length: 25 }, () => ({
			...f.media,
			id: randomUUID(),
			state: "ERROR",
		})),
		f.media,
	];
	const analyses = [
		...Array.from({ length: 25 }, () => ({
			...f.analysis,
			id: randomUUID(),
			rawHash: "b".repeat(64),
		})),
		f.analysis,
	];
	const source = {
		...f.source,
		jobId: null,
		originalJobId: null,
		accountId: null,
		snapshot: {
			schemaVersion: 1,
			kind: "VOD_JOB",
			name: "Output",
			identity: "UNVERIFIED",
			planHash: "d".repeat(64),
			inputs: [],
			fileOutputs: f.outputs,
			playbackLinks: [],
			qcVerdict: null,
			qcOverriddenAt: null,
		},
	};
	state.browser.mockResolvedValue({
		headObject: async () => ({ size: 100, etag: '"encoded"' }),
		dispose: vi.fn(),
	});
	const mediaFindMany = vi.fn(
		async (query: { where?: { state?: unknown }; take?: number }) => {
			const requested = query.where?.state;
			const eligible =
				typeof requested === "string"
					? rows.filter((row) => row.state === requested)
					: requested && typeof requested === "object" && "in" in requested
						? rows.filter((row) =>
								(requested.in as string[]).includes(row.state),
							)
						: rows;
			return eligible.slice(0, query.take);
		},
	);
	const bindingFindMany = vi.fn(async () =>
		f.bindings.map((row) => ({
			...row,
			mediaVersion: f.media,
			analysisRevision: f.analysis,
		})),
	);
	state.context = {
		tenant: { organizationId: f.organizationId },
		prisma: {
			librarySource: { findUnique: async () => source },
			libraryMediaVersion: { findMany: mediaFindMany },
			sceneAnalysisRevision: {
				findMany: async (query: {
					take?: number;
					where?: { id?: { in: string[] } };
				}) => {
					const ids = query.where?.id?.in;
					return (
						ids ? analyses.filter((row) => ids.includes(row.id)) : analyses
					).slice(0, query.take);
				},
			},
			libraryAnalysisBinding: { findMany: bindingFindMany },
		},
	} as unknown as ServerContext;
	const view = await editingEligibility(f.source.id);
	expect(view.automatic).toMatchObject({
		status: "READY",
		mediaVersionId: f.media.id,
		analysisRevisionId: f.analysis.id,
	});
	expect(view.mediaVersions).toHaveLength(26);
	expect(view.analyses).toHaveLength(26);
	expect(view.mediaVersions.some((row) => row.id === f.media.id)).toBe(true);
	expect(view.analyses.some((row) => row.id === f.analysis.id)).toBe(true);
	expect(
		mediaFindMany.mock.calls.every(
			([query]) => !!query.take && query.take <= 101,
		),
	).toBe(true);
});

afterEach(() => vi.useRealTimers());

it("refuses a binding overflow with a sentinel before fetching or adopting a partial history", async () => {
	const f = fixture();
	const findMany = vi.fn(async () =>
		Array.from({ length: 101 }, () => ({
			mediaVersionId: f.media.id,
			analysisRevisionId: f.analysis.id,
		})),
	);
	const prisma = {
		libraryAnalysisBinding: { findMany },
	} as unknown as AppPrismaClient;
	await expect(
		loadAutomaticEditingCandidates({
			prisma,
			source: f.source,
			organizationId: f.organizationId,
			recentAnalyses: f.analyses,
		}),
	).resolves.toEqual({ media: [], analyses: [], limitExceeded: true });
	expect(findMany).toHaveBeenCalledWith(
		expect.objectContaining({
			take: 101,
			where: {
				organizationId: f.organizationId,
				mediaVersion: { sourceId: f.source.id, state: "READY" },
				analysisRevision: { sourceId: f.source.id },
			},
		}),
	);
});

it("does not look up a foreign source's candidates", async () => {
	const f = fixture();
	f.source.organizationId = randomUUID();
	await expect(
		loadAutomaticEditingCandidates({
			prisma: f.prisma,
			source: f.source,
			organizationId: f.organizationId,
			recentAnalyses: f.analyses,
		}),
	).resolves.toMatchObject({ media: [], limitExceeded: false });
	expect(f.findMany).not.toHaveBeenCalled();
});

it("passes a single-attempt SDK deadline and disposes a completed HEAD", async () => {
	const f = fixture();
	const dispose = vi.fn();
	const headObject = vi.fn(async () => ({ size: 100, etag: '"encoded"' }));
	state.browser.mockResolvedValue({ headObject, dispose });
	await expect(
		readAutomaticEditingOutputIdentity(state.context, f.output),
	).resolves.toMatchObject({ size: 100 });
	expect(state.browser).toHaveBeenLastCalledWith(
		state.context,
		f.output.credentialId,
		undefined,
		{ readTimeoutMs: 5000 },
	);
	expect(headObject).toHaveBeenCalledWith({
		bucket: f.output.bucket,
		key: f.output.path,
	});
	expect(dispose).toHaveBeenCalledTimes(1);
});

it("disposes on the deadline and waits for in-flight HEAD settlement before rejecting late success", async () => {
	vi.useFakeTimers();
	const f = fixture();
	let release!: (value: ObjectIdentity) => void;
	const head = new Promise<ObjectIdentity>((resolve) => {
		release = resolve;
	});
	const dispose = vi.fn();
	state.browser.mockResolvedValue({ headObject: () => head, dispose });
	let returned = false;
	const reading = readAutomaticEditingOutputIdentity(state.context, f.output);
	const result = reading.then(
		() => {
			returned = true;
			return "accepted";
		},
		() => {
			returned = true;
			return "rejected";
		},
	);
	await vi.advanceTimersByTimeAsync(5000);
	expect(dispose).toHaveBeenCalledTimes(1);
	expect(returned).toBe(false);
	release({ size: 100, etag: '"encoded"' });
	expect(await result).toBe("rejected");
	expect(dispose).toHaveBeenCalledTimes(1);
});

it("does not start a HEAD if credential resolution outlives its deadline", async () => {
	vi.useFakeTimers();
	const f = fixture();
	let release!: (value: unknown) => void;
	state.browser.mockReturnValue(
		new Promise((resolve) => {
			release = resolve;
		}),
	);
	const headObject = vi.fn(),
		dispose = vi.fn();
	const reading = readAutomaticEditingOutputIdentity(state.context, f.output);
	const rejected = expect(reading).rejects.toThrow(
		"OUTPUT_IDENTITY_UNVERIFIED",
	);
	await vi.advanceTimersByTimeAsync(5000);
	release({ headObject, dispose });
	await rejected;
	expect(headObject).not.toHaveBeenCalled();
	expect(dispose).toHaveBeenCalledTimes(1);
});
