import { access } from "node:fs/promises";
import { hashEditingEvidence, normalizeSceneAnalysis } from "@bitovp/core";
import { matchesWhere } from "@bitovp/core/testing";
import type { AppPrismaClient } from "@bitovp/db";
import type { ObjectStorageBrowser } from "@bitovp/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSweepLoop } from "../lifecycle";
import { createTenantDispatcher } from "../tenant/dispatch";
import {
	currentOrganizationId,
	forEachTenantService,
	tenantService,
} from "../tenant/scope";

const mocks = vi.hoisted(() => ({
	download: vi.fn(),
	probe: vi.fn(),
	render: vi.fn(),
	adopt: vi.fn(),
	promote: vi.fn(),
	normalize: vi.fn(),
	reconcile: vi.fn(),
}));
vi.mock("./normalization", () => ({ normalizeEditingMedia: mocks.normalize }));
vi.mock("../library/captured-bindings", () => ({
	reconcileCapturedBindings: mocks.reconcile,
}));
vi.mock("./media", () => ({
	downloadPinnedEditingMedia: mocks.download,
	probeEditingMedia: mocks.probe,
}));
vi.mock("./render", () => ({
	renderEditingRecipe: mocks.render,
	editingRenderCanvas: (_canvas: unknown, mode: string) =>
		mode === "PREVIEW"
			? { width: 640, height: 360 }
			: { width: 1920, height: 1080 },
}));
vi.mock("./derivatives", () => ({
	adoptEditingArtifact: mocks.adopt,
	promoteEditingArtifact: mocks.promote,
	LIBRARY_REGISTRATION_PENDING: "LIBRARY_REGISTRATION_PENDING",
}));

import { MediaOperationError } from "./process";
import {
	createLibraryEditingSweep,
	EDITING_HEARTBEAT_MS,
	EDITING_RECOVERY_RETRY_MS,
} from "./sweep";

const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const instant = new Date("2026-11-01T00:00:00Z");
const sha256 = "1".repeat(64);
const sourceFacts = {
	width: 320,
	height: 180,
	frameCount: 60,
	durationUs: 2_000_000,
	fps: { num: 30, den: 1 },
	hasAudio: true,
	probe: { supported: true },
};

afterEach(() => {
	vi.useRealTimers();
	vi.resetAllMocks();
});

function setup(
	mediaOverrides: Record<string, unknown> = {},
	signal?: AbortSignal,
) {
	let current = instant;
	const media: Record<string, unknown> = {
		id: id(1),
		organizationId: id(100),
		sourceId: id(2),
		state: "PENDING",
		attempts: 0,
		availableAt: instant,
		leaseToken: null,
		leaseUntil: null,
		storage: {
			source: {
				credentialId: id(3),
				bucket: "input",
				key: "original.mp4",
				size: 20,
				expect: { etag: '"source"' },
			},
			output: { credentialId: id(4), bucket: "output", prefix: "clips/" },
		},
		sha256,
		timeMap: {
			id: id(1),
			mediaVersionId: id(1),
			kind: "CFR",
			sourceStartUs: 0,
			sourceEndUs: 2_000_000,
			editingStartFrame: 0,
			editingEndFrame: 60,
			fps: { num: 30, den: 1 },
		},
		...mediaOverrides,
	};
	const runs: Record<string, unknown>[] = [];
	const mutate = (
		row: Record<string, unknown>,
		data: Record<string, unknown>,
	) => {
		for (const [key, value] of Object.entries(data))
			row[key] =
				value && typeof value === "object" && "increment" in value
					? Number(row[key]) + Number(value.increment)
					: value;
	};
	const mediaUpdate = vi.fn(async ({ where, data }) => {
		if (!matchesWhere(media, where)) return { count: 0 };
		mutate(media, data);
		return { count: 1 };
	});
	const runUpdate = vi.fn(async ({ where, data }) => {
		const matching = runs.filter((run) => matchesWhere(run, where));
		for (const run of matching) mutate(run, data);
		return { count: matching.length };
	});
	const db = {
		$transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
			callback(db),
		),
		libraryEvidenceReceipt: {
			findMany: vi.fn(async () => []),
			create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
				id: id(110),
				...data,
			})),
		},
		libraryMediaVersion: {
			updateMany: mediaUpdate,
			findMany: vi.fn(async ({ where }) =>
				matchesWhere(media, where) ? [media] : [],
			),
			findUnique: vi.fn(async () => media),
		},
		renderRun: {
			updateMany: runUpdate,
			findMany: vi.fn(async ({ where, take }) =>
				runs.filter((run) => matchesWhere(run, where)).slice(0, take),
			),
			findUnique: vi.fn(
				async ({ where }) =>
					runs.find((run) => matchesWhere(run, where)) ?? null,
			),
		},
		editProject: {
			findUnique: vi.fn(async () => ({
				id: id(5),
				mediaVersion: media,
				archived: false,
			})),
		},
		editRevision: {
			findUnique: vi.fn(async () => ({
				id: id(6),
				projectId: id(5),
				document: {
					schemaVersion: 1,
					mediaVersionId: id(1),
					timeMapId: id(1),
					analysisRevisionId: null,
					locale: "und",
					sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
					canvas: { width: 1920, height: 1080 },
					fps: { num: 30, den: 1 },
					clips: [
						{
							id: id(7),
							sourceInUs: 0,
							durationFrames: 30,
							timelineStartFrame: 0,
							framing: [
								{ fromFrame: 0, toFrame: 30, mode: "FIT", origin: "MANUAL" },
							],
							audio: { mode: "SOURCE" },
						},
					],
				},
			})),
		},
		sceneAnalysisRevision: {
			findUnique: vi.fn(async () => null as Record<string, unknown> | null),
		},
		libraryAnalysisBinding: {
			findMany: vi.fn(async () => [] as Array<{ proof: unknown }>),
		},
	};
	const stored = new Set<string>();
	const browser: ObjectStorageBrowser = {
		listBuckets: async () => [],
		listObjects: async () => ({ objects: [], prefixes: [] }),
		putObject: vi.fn(async ({ key }) => {
			stored.add(key);
		}),
		headObject: vi.fn(async ({ key }) => {
			if (!stored.has(key))
				throw Object.assign(new Error("missing"), { statusCode: 404 });
			return { size: 20, etag: '"output"', versionId: "version-1" };
		}),
		dispose: vi.fn(),
	};
	mocks.download.mockImplementation(async () => ({
		identity: { size: 20, etag: '"source"' },
		sha256,
		bytes: 20,
	}));
	mocks.probe.mockImplementation(async ({ sourcePath }) =>
		sourcePath.endsWith("artifact.mp4")
			? {
					...sourceFacts,
					width: 1920,
					height: 1080,
					frameCount: 30,
					durationUs: 1_000_000,
				}
			: sourceFacts,
	);
	mocks.normalize.mockImplementation(
		async ({ sourcePath, expectedSourceSha256, signal }) => {
			const facts = await mocks.probe({ sourcePath, signal });
			const index = Array.from(
				{ length: facts.frameCount },
				(_, frame) => frame,
			);
			return {
				path: sourcePath,
				facts,
				originalSha256: expectedSourceSha256,
				preparedSha256: expectedSourceSha256,
				bytes: 20,
				normalization: {
					schemaVersion: 1,
					profile: "SDR_CFR30_INDEXED_V1",
					mode: "IDENTITY_COPY",
					originalSha256: expectedSourceSha256,
					preparedSha256: expectedSourceSha256,
					originalBytes: 20,
					preparedBytes: 20,
					source: {
						width: facts.width,
						height: facts.height,
						codec: "h264",
						fps: facts.fps,
						timeBase: { num: 1, den: 30000 },
						frameCount: facts.frameCount,
						durationUs: facts.durationUs,
						videoPtsHash: sha256,
						colorProfile: "BT709_8BIT_LIMITED",
						audio: {
							sampleRate: 48000,
							channels: 2,
							sampleCount: facts.frameCount * 1600,
							ptsHash: sha256,
						},
					},
					output: {
						width: facts.width,
						height: facts.height,
						frameCount: facts.frameCount,
						durationUs: facts.durationUs,
						fps: facts.fps,
						hasAudio: facts.hasAudio,
					},
					sourceStartUs: 0,
					sourceEndUs: facts.durationUs,
					sourceFrameIndex: index,
					indexMapHash: hashEditingEvidence(index),
					recipeHash: sha256,
				},
			};
		},
	);
	mocks.reconcile.mockResolvedValue({ created: 0, preserved: 0 });
	mocks.render.mockResolvedValue({
		width: 1920,
		height: 1080,
		durationUs: 1_000_000,
		frameCount: 30,
		hasAudio: true,
		sha256,
		bytes: 20,
	});
	mocks.adopt.mockImplementation(async ({ runId }) => {
		const run = runs.find((row) => row.id === runId);
		if (run)
			mutate(run, {
				state: "SUCCEEDED",
				leaseToken: null,
				leaseUntil: null,
				pendingArtifactToken: null,
				error:
					(run.profile as { kind: string }).kind === "EXPORT"
						? "LIBRARY_REGISTRATION_PENDING"
						: null,
			});
		return id(8);
	});
	mocks.promote.mockImplementation(async ({ runId }) => {
		const run = runs.find((row) => row.id === runId);
		if (run) run.error = null;
		return true;
	});
	const browserFor = vi.fn(async (_credentialId: string) => browser);
	const tick = createLibraryEditingSweep({
		prisma: db as unknown as AppPrismaClient,
		browserFor,
		now: () => current,
		signal,
	});
	return {
		media,
		db,
		browser,
		browserFor,
		stored,
		tick,
		advance: (ms: number) => {
			current = new Date(current.getTime() + ms);
		},
		setRun: (value: Record<string, unknown>) => {
			runs.splice(0, runs.length, value);
		},
		addRun: (value: Record<string, unknown>) => {
			runs.push(value);
		},
		getRun: (runId?: string) =>
			(runId ? runs.find((row) => row.id === runId) : runs[0]) ?? null,
	};
}

describe("durable editing media preparation", () => {
	it("keeps a source rejected as incomplete out of READY and never uploads prepared bytes", async () => {
		const f = setup();
		mocks.probe.mockRejectedValueOnce(
			new MediaOperationError("SOURCE_INCOMPLETE"),
		);
		await f.tick();
		expect(mocks.download).toHaveBeenCalledOnce();
		expect(f.media).toMatchObject({
			state: "ERROR",
			error: "SOURCE_INCOMPLETE",
			leaseToken: null,
		});
		expect(f.browser.putObject).not.toHaveBeenCalled();
		expect(f.stored.size).toBe(0);
		expect(
			(f.media.storage as { prepared?: unknown }).prepared,
		).toBeUndefined();
	});
	it("refuses an unversioned null marker without an immutable selector", async () => {
		const f = setup();
		if (!f.browser.headObject) throw new Error("HEAD fixture is required");
		vi.mocked(f.browser.headObject).mockResolvedValue({
			size: 20,
			versionId: "null",
		});
		await f.tick();
		expect(f.media).toMatchObject({
			state: "ERROR",
			error: "MEDIA_PREPARATION_FAILED",
		});
		expect(
			(f.media.storage as { prepared?: unknown }).prepared,
		).toBeUndefined();
	});
	it("pins source bytes, copies only to a unique output key, then seals READY evidence", async () => {
		const f = setup();
		await f.tick();
		expect(f.media).toMatchObject({
			state: "READY",
			sha256,
			durationUs: 2_000_000n,
			width: 320,
			height: 180,
			leaseToken: null,
		});
		expect(f.media.timeMap).toMatchObject({ id: id(1), editingEndFrame: 60 });
		const storage = f.media.storage as {
			prepared: { key: string; expect: object; size: number };
		};
		expect(storage.prepared.key).toMatch(
			new RegExp(`^clips/media/${id(1)}/[a-f0-9-]+/source\\.mp4$`),
		);
		expect(storage.prepared.expect).toEqual({
			etag: '"output"',
			versionId: "version-1",
		});
		expect(storage.prepared.size).toBe(20);
		expect(mocks.download.mock.calls[0]?.[0].expectedIdentity).toEqual({
			size: 20,
			etag: '"source"',
		});
		await expect(
			access(mocks.download.mock.calls[0]?.[0].destinationPath),
		).rejects.toThrow();
		expect(f.stored.has("original.mp4")).toBe(false);
	});
	it("leaves an active lease alone but can recover an expired media owner", async () => {
		const active = setup({
			state: "RUNNING",
			leaseToken: id(20),
			leaseUntil: new Date(instant.getTime() + 1),
		});
		await active.tick();
		expect(active.media.state).toBe("RUNNING");
		expect(mocks.download).not.toHaveBeenCalled();
		const expired = setup({
			state: "RUNNING",
			leaseToken: id(20),
			leaseUntil: new Date(instant.getTime() - 1),
		});
		await expired.tick();
		expect(expired.media.state).toBe("READY");
	});
	it("does not publish a late media response after ownership changed", async () => {
		const f = setup();
		mocks.download.mockImplementationOnce(async () => {
			f.media.leaseToken = id(21);
			return { identity: { size: 20, etag: "old" }, sha256, bytes: 20 };
		});
		await f.tick();
		expect(f.media.state).toBe("RUNNING");
		expect(f.media.leaseToken).toBe(id(21));
		expect(f.stored.size).toBe(0);
	});
	it("stores a fixed failure code instead of provider secrets or locators", async () => {
		const f = setup();
		mocks.download.mockRejectedValueOnce(
			new Error("https://private-bucket/?apiKey=secret"),
		);
		await f.tick();
		expect(f.media).toMatchObject({
			state: "ERROR",
			error: "MEDIA_PREPARATION_FAILED",
			leaseToken: null,
		});
	});
});

function renderSetup(signal?: AbortSignal) {
	const f = setup({ state: "READY" }, signal);
	const storage = f.media.storage as Record<string, unknown>;
	storage.prepared = {
		credentialId: id(4),
		bucket: "output",
		key: "clips/media/fixed/source.mp4",
		size: 20,
		expect: { etag: '"prepared"' },
	};
	f.setRun({
		id: id(9),
		projectId: id(5),
		revisionId: id(6),
		state: "QUEUED",
		attempts: 0,
		availableAt: instant,
		leaseToken: null,
		leaseUntil: null,
		pendingArtifactToken: null,
		cancelRequestedAt: null,
		generation: 1,
		profile: { kind: "EXPORT" },
		outputCredentialId: id(4),
		outputBucket: "output",
		outputPrefix: "clips/",
		error: null,
	});
	return f;
}

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function automaticRenderSetup() {
	const f = renderSetup();
	const organizationId = id(100);
	Object.assign(f.media, {
		organizationId,
		width: 320,
		height: 180,
		probe: {},
	});
	Object.assign(f.getRun() ?? {}, { organizationId });
	const analysis = {
		id: id(101),
		organizationId,
		sourceId: id(2),
		locale: "ja",
		rawHash: "a".repeat(64),
		document: normalizeSceneAnalysis({
			metadata: { version: "automatic-sweep-test" },
			duration: 2,
			scenes: [],
		}),
	};
	f.db.sceneAnalysisRevision.findUnique.mockResolvedValue(analysis);
	const binding = {
		schemaVersion: 1,
		kind: "FIXTURE_AUTHORED",
		organizationId,
		sourceId: id(2),
		locale: "ja",
		analysisRevisionId: analysis.id,
		analysisRawHash: analysis.rawHash,
		analysisDocumentHash: hashEditingEvidence(analysis.document),
		mediaVersionId: id(1),
		mediaSha256: sha256,
		timeMapId: id(1),
		timeMapHash: hashEditingEvidence(f.media.timeMap),
		sourceStartUs: 0,
		sourceEndUs: 2_000_000,
		width: 320,
		height: 180,
	};
	f.media.probe = { bitovpAnalysisBindings: [binding] };
	f.db.libraryAnalysisBinding.findMany.mockResolvedValue([{ proof: binding }]);
	const revision = await f.db.editRevision.findUnique();
	Object.assign(revision, { organizationId });
	Object.assign(revision.document, {
		analysisRevisionId: analysis.id,
		locale: "ja",
		autoGeneration: {
			policyVersion: "aisa-shot-window-v1",
			requestHash: "f".repeat(64),
			requestedDurationFrames: 30,
			generatedDurationFrames: 30,
			reasonCodes: [],
			binding,
		},
	});
	f.db.editRevision.findUnique.mockResolvedValue(revision);
	const project = await f.db.editProject.findUnique();
	Object.assign(project, { organizationId });
	f.db.editProject.findUnique.mockResolvedValue(project);
	return { ...f, analysis, binding };
}

describe("automatic render binding gate", () => {
	it("renders a revision only while its exact server-authored binding still matches", async () => {
		const f = await automaticRenderSetup();
		await f.tick();
		expect(f.getRun()?.state).toBe("SUCCEEDED");
		expect(f.db.sceneAnalysisRevision.findUnique).toHaveBeenCalledWith({
			where: { id: f.analysis.id },
		});
		expect(f.db.libraryAnalysisBinding.findMany).toHaveBeenCalledWith({
			where: {
				organizationId: id(100),
				mediaVersionId: id(1),
				analysisRevisionId: f.analysis.id,
			},
			select: { proof: true },
			take: 26,
		});
		expect(mocks.render).toHaveBeenCalledOnce();
	});
	it.each([
		[
			"missing sealed proof",
			(f: Awaited<ReturnType<typeof automaticRenderSetup>>) => {
				f.db.libraryAnalysisBinding.findMany.mockResolvedValue([]);
			},
		],
		[
			"new source hash",
			(f: Awaited<ReturnType<typeof automaticRenderSetup>>) => {
				f.media.sha256 = "b".repeat(64);
			},
		],
		[
			"changed analysis",
			(f: Awaited<ReturnType<typeof automaticRenderSetup>>) => {
				f.analysis.document.title = "changed";
			},
		],
		[
			"foreign analysis",
			(f: Awaited<ReturnType<typeof automaticRenderSetup>>) => {
				f.analysis.organizationId = id(999);
			},
		],
		[
			"missing analysis",
			(f: Awaited<ReturnType<typeof automaticRenderSetup>>) => {
				f.db.sceneAnalysisRevision.findUnique.mockResolvedValue(null);
			},
		],
	])("fails closed before storage, render or adoption on %s", async (_name, mutate) => {
		const f = await automaticRenderSetup();
		mutate(f);
		await f.tick();
		expect(f.getRun()).toMatchObject({
			state: "FAILED",
			error: "ANALYSIS_BINDING_UNVERIFIED",
		});
		expect(f.browserFor).not.toHaveBeenCalled();
		expect(mocks.download).not.toHaveBeenCalled();
		expect(mocks.render).not.toHaveBeenCalled();
		expect(mocks.adopt).not.toHaveBeenCalled();
	});
	it("does not recover or adopt an old uploaded artifact after evidence is invalidated", async () => {
		const f = await automaticRenderSetup();
		f.db.libraryAnalysisBinding.findMany.mockResolvedValue([]);
		Object.assign(f.getRun() ?? {}, {
			state: "VALIDATING",
			attempts: 3,
			leaseToken: id(50),
			pendingArtifactToken: id(50),
			leaseUntil: new Date(instant.getTime() - 1),
		});
		await f.tick();
		expect(f.getRun()).toMatchObject({
			state: "FAILED",
			error: "ANALYSIS_BINDING_UNVERIFIED",
		});
		expect(f.browserFor).not.toHaveBeenCalled();
		expect(mocks.adopt).not.toHaveBeenCalled();
	});
	it("leaves the legacy manual path independent of analysis evidence", async () => {
		const f = renderSetup();
		await f.tick();
		expect(f.getRun()?.state).toBe("SUCCEEDED");
		expect(f.db.sceneAnalysisRevision.findUnique).not.toHaveBeenCalled();
		expect(f.db.libraryAnalysisBinding.findMany).not.toHaveBeenCalled();
	});
});

describe("editing sweep tenant fairness", () => {
	it("reaches both organizations on three dispatcher ticks when the first organization is empty", async () => {
		const visits: string[] = [];
		const db = {
			libraryEvidenceReceipt: { findMany: async () => [] },
			renderRun: {
				findMany: async () => [],
				updateMany: async () => ({ count: 0 }),
			},
			libraryMediaVersion: {
				findMany: async () => {
					visits.push(currentOrganizationId() ?? "missing");
					return [];
				},
				updateMany: async () => ({ count: 0 }),
			},
		};
		const sweep = tenantService(() =>
			createLibraryEditingSweep({
				prisma: db as unknown as AppPrismaClient,
				browserFor: async () => {
					throw new Error("Empty organizations need no storage");
				},
			}),
		);
		const loops = tenantService(() => createSweepLoop(() => sweep()));
		const dispatch = createTenantDispatcher({
			organization: {
				findMany: async () => [{ id: id(100) }, { id: id(101) }],
			},
		});
		for (let tick = 0; tick < 3; tick++) {
			await dispatch(() => loops.run());
			await Promise.all(forEachTenantService(loops, (loop) => loop.drain()));
		}
		expect(visits).toEqual([
			id(100),
			id(101),
			id(100),
			id(101),
			id(100),
			id(101),
		]);
	});
	it("prepares both tenants while keeping only one media task active", async () => {
		const first = setup();
		const second = setup();
		const entered = gate();
		const release = gate();
		let active = 0;
		let peak = 0;
		let downloads = 0;
		mocks.download.mockImplementation(async () => {
			active++;
			peak = Math.max(peak, active);
			if (++downloads === 1) {
				entered.resolve();
				await release.promise;
			}
			active--;
			return { identity: { size: 20, etag: '"source"' }, sha256, bytes: 20 };
		});
		const firstWork = first.tick();
		const secondWork = second.tick();
		await entered.promise;
		release.resolve();
		await Promise.all([firstWork, secondWork]);
		expect(first.media.state).toBe("READY");
		expect(second.media.state).toBe("READY");
		expect(downloads).toBe(2);
		expect(peak).toBe(1);
	});
	it("coalesces repeated interval calls into one queued sweep per tenant", async () => {
		const first = setup({ state: "READY" });
		const second = setup({ state: "READY" });
		const entered = gate();
		const release = gate();
		first.db.renderRun.findMany.mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
			return [];
		});
		const firstWork = first.tick();
		await entered.promise;
		const repeated = Array.from({ length: 50 }, () => second.tick());
		release.resolve();
		await Promise.all([firstWork, ...repeated]);
		expect(second.db.libraryMediaVersion.findMany).toHaveBeenCalledOnce();
	});
	it("drains an aborted queued tenant without starting its database queries", async () => {
		const first = setup({ state: "READY" });
		const shutdown = new AbortController();
		const second = setup({}, shutdown.signal);
		const entered = gate();
		const release = gate();
		first.db.renderRun.findMany.mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
			return [];
		});
		const firstWork = first.tick();
		await entered.promise;
		const loop = createSweepLoop(second.tick);
		loop.run();
		let drained = false;
		const drain = loop.drain().then(() => {
			drained = true;
		});
		await Promise.resolve();
		shutdown.abort();
		try {
			await vi.waitFor(() => expect(drained).toBe(true));
			expect(second.db.renderRun.findMany).not.toHaveBeenCalled();
			expect(second.db.libraryMediaVersion.findMany).not.toHaveBeenCalled();
			expect(second.media.state).toBe("PENDING");
		} finally {
			release.resolve();
			await Promise.all([firstWork, drain]);
		}
	});
	it("continues to the next tenant after a preceding sweep fails", async () => {
		const first = setup({ state: "READY" });
		const second = setup({ state: "READY" });
		first.db.renderRun.findMany.mockRejectedValueOnce(
			new Error("DB unavailable"),
		);
		const results = await Promise.allSettled([first.tick(), second.tick()]);
		expect(results[0]).toMatchObject({
			status: "rejected",
			reason: { code: "EDITING_SWEEP_FAILED" },
		});
		expect(results[1]?.status).toBe("fulfilled");
		expect(second.db.libraryMediaVersion.findMany).toHaveBeenCalledOnce();
	});
});

describe("durable editing rendering", () => {
	it("keeps an expired cancellation unconfirmed rather than inventing process-stop evidence", async () => {
		const f = renderSetup();
		Object.assign(f.getRun() ?? {}, {
			state: "CANCEL_REQUESTED",
			cancelRequestedAt: instant,
			leaseToken: id(40),
			leaseUntil: new Date(instant.getTime() - 1),
		});
		await f.tick();
		expect(f.getRun()).toMatchObject({
			state: "CANCEL_REQUESTED",
			error: "PROCESS_STOP_UNCONFIRMED",
			leaseToken: id(40),
		});
		expect(mocks.render).not.toHaveBeenCalled();
	});
	it("does not claim another job after worker shutdown", async () => {
		const shutdown = new AbortController();
		shutdown.abort();
		const f = renderSetup(shutdown.signal);
		await f.tick();
		expect(f.getRun()?.state).toBe("QUEUED");
		expect(mocks.render).not.toHaveBeenCalled();
	});
	it("worker shutdown stops its media process and leaves the lease for restart recovery", async () => {
		const shutdown = new AbortController();
		const f = renderSetup(shutdown.signal);
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		mocks.render.mockImplementationOnce(async ({ signal }) => {
			entered();
			await new Promise<void>((_resolve, reject) => {
				signal.addEventListener("abort", () =>
					reject(new MediaOperationError("CANCELED")),
				);
			});
		});
		const work = f.tick();
		await started;
		shutdown.abort();
		await work;
		expect(f.getRun()?.state).toBe("RENDERING");
		expect(f.getRun()?.leaseToken).not.toBeNull();
		expect(mocks.adopt).not.toHaveBeenCalled();
	});
	it("worker shutdown closes an in-flight storage upload before draining", async () => {
		const shutdown = new AbortController();
		const f = renderSetup(shutdown.signal);
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let failUpload!: () => void;
		f.browser.putObject = vi.fn(async () => {
			entered();
			await new Promise<void>((_resolve, reject) => {
				failUpload = () => reject(new Error("transport closed"));
			});
		});
		f.browser.dispose = vi.fn(() => failUpload());
		const work = f.tick();
		await started;
		shutdown.abort();
		await work;
		expect(f.getRun()?.state).toBe("VALIDATING");
		expect(f.getRun()?.leaseToken).not.toBeNull();
		expect(mocks.adopt).not.toHaveBeenCalled();
	});
	it("replays a fixed revision with pinned prepared bytes and adopts only validated output", async () => {
		const f = renderSetup();
		await f.tick();
		expect(f.getRun()?.state).toBe("SUCCEEDED");
		expect(mocks.download.mock.calls[0]?.[0]).toMatchObject({
			expectedSha256: sha256,
			expectedIdentity: { size: 20, etag: '"prepared"' },
		});
		expect(mocks.adopt.mock.calls[0]?.[0].evidence.storage.expect).toEqual({
			etag: '"output"',
			versionId: "version-1",
		});
		expect(mocks.render.mock.calls[0]?.[0].recipe.durationFrames).toBe(30);
		expect(mocks.promote).toHaveBeenCalledOnce();
	});
	it("recovers upload-success/DB-failure from its prior attempt object without rendering again", async () => {
		const f = renderSetup();
		mocks.adopt.mockRejectedValueOnce(new Error("DB connection lost"));
		await f.tick();
		expect(f.getRun()).toMatchObject({
			state: "VALIDATING",
			error: "ARTIFACT_ADOPTION_PENDING",
		});
		f.advance(EDITING_RECOVERY_RETRY_MS);
		await f.tick();
		expect(f.getRun()?.state).toBe("SUCCEEDED");
		expect(mocks.render).toHaveBeenCalledOnce();
		expect(f.stored.size).toBe(1);
	});
	it("retains the uploaded artifact across repeated adoption failures when prepared media is unavailable", async () => {
		const f = renderSetup();
		mocks.adopt.mockRejectedValueOnce(new Error("DB unavailable"));
		mocks.adopt.mockRejectedValueOnce(new Error("DB still unavailable"));
		await f.tick();
		const originalKey = [...f.stored][0];
		if (!originalKey) throw new Error("Expected an uploaded artifact");
		mocks.download.mockImplementation(async ({ key }) => {
			if (key !== originalKey) throw new MediaOperationError("SOURCE_CHANGED");
			return { identity: { size: 20, etag: '"output"' }, sha256, bytes: 20 };
		});
		f.advance(EDITING_RECOVERY_RETRY_MS);
		await f.tick();
		f.advance(EDITING_RECOVERY_RETRY_MS);
		await f.tick();
		expect(f.getRun()).toMatchObject({
			state: "SUCCEEDED",
			attempts: 1,
			pendingArtifactToken: null,
		});
		expect(mocks.adopt).toHaveBeenCalledTimes(3);
		expect(mocks.render).toHaveBeenCalledOnce();
		expect(f.stored.size).toBe(1);
		expect(
			mocks.download.mock.calls.slice(1).map(([input]) => input.key),
		).toEqual([originalKey, originalKey]);
	});
	it("recovers the third render attempt even after adoption fails more than the render budget", async () => {
		const f = renderSetup();
		Object.assign(f.getRun() ?? {}, { attempts: 2 });
		mocks.adopt.mockRejectedValueOnce(new Error("DB unavailable"));
		mocks.adopt.mockRejectedValueOnce(new Error("DB unavailable again"));
		mocks.adopt.mockRejectedValueOnce(new Error("DB unavailable a third time"));
		await f.tick();
		const originalKey = [...f.stored][0];
		if (!originalKey) throw new Error("Expected the third attempt's artifact");
		mocks.download.mockImplementation(async ({ key }) => {
			if (key !== originalKey) throw new MediaOperationError("SOURCE_CHANGED");
			return { identity: { size: 20, etag: '"output"' }, sha256, bytes: 20 };
		});
		for (let retry = 0; retry < 3; retry++) {
			f.advance(EDITING_RECOVERY_RETRY_MS);
			await f.tick();
		}
		expect(f.getRun()).toMatchObject({
			state: "SUCCEEDED",
			attempts: 3,
			pendingArtifactToken: null,
		});
		expect(mocks.adopt).toHaveBeenCalledTimes(4);
		expect(mocks.render).toHaveBeenCalledOnce();
	});
	it("recovers a durable artifact token after a lease claim crashed before validation", async () => {
		const f = renderSetup();
		const artifactToken = id(50);
		const originalKey = `clips/renders/${id(9)}/${artifactToken}/artifact.mp4`;
		f.stored.add(originalKey);
		Object.assign(f.getRun() ?? {}, {
			state: "PREPARING",
			attempts: 3,
			leaseToken: id(51),
			leaseUntil: new Date(instant.getTime() - 1),
			pendingArtifactToken: artifactToken,
		});
		mocks.download.mockImplementation(async ({ key }) => {
			if (key !== originalKey) throw new MediaOperationError("SOURCE_CHANGED");
			return { identity: { size: 20, etag: '"output"' }, sha256, bytes: 20 };
		});
		await f.tick();
		expect(f.getRun()).toMatchObject({
			state: "SUCCEEDED",
			attempts: 3,
			pendingArtifactToken: null,
		});
		expect(mocks.render).not.toHaveBeenCalled();
	});
	it("backfills a legacy validating lease and preserves it through another adoption failure", async () => {
		const f = renderSetup();
		const originalLease = id(50);
		const originalKey = `clips/renders/${id(9)}/${originalLease}/artifact.mp4`;
		f.stored.add(originalKey);
		Object.assign(f.getRun() ?? {}, {
			state: "VALIDATING",
			attempts: 3,
			leaseToken: originalLease,
			leaseUntil: new Date(instant.getTime() - 1),
		});
		mocks.adopt.mockRejectedValueOnce(new Error("DB unavailable"));
		await f.tick();
		expect(f.getRun()).toMatchObject({
			state: "VALIDATING",
			attempts: 3,
			pendingArtifactToken: originalLease,
		});
		f.advance(EDITING_RECOVERY_RETRY_MS);
		await f.tick();
		expect(f.getRun()?.state).toBe("SUCCEEDED");
		expect(mocks.render).not.toHaveBeenCalled();
	});
	it("does not render again when a missing pending artifact has exhausted its render budget", async () => {
		const f = renderSetup();
		Object.assign(f.getRun() ?? {}, {
			state: "VALIDATING",
			attempts: 3,
			leaseToken: id(51),
			leaseUntil: new Date(instant.getTime() - 1),
			pendingArtifactToken: id(50),
		});
		await f.tick();
		expect(f.getRun()).toMatchObject({
			state: "FAILED",
			attempts: 3,
			error: "RENDER_ATTEMPTS_EXHAUSTED",
		});
		expect(mocks.download).not.toHaveBeenCalled();
		expect(mocks.render).not.toHaveBeenCalled();
	});
	it("reserves one remaining render attempt only after the old artifact is confirmed missing", async () => {
		const f = renderSetup();
		Object.assign(f.getRun() ?? {}, {
			state: "VALIDATING",
			attempts: 2,
			leaseToken: id(51),
			leaseUntil: new Date(instant.getTime() - 1),
			pendingArtifactToken: id(50),
		});
		await f.tick();
		expect(f.getRun()).toMatchObject({
			state: "SUCCEEDED",
			attempts: 3,
			pendingArtifactToken: null,
		});
		expect(mocks.render).toHaveBeenCalledOnce();
		expect(f.stored.size).toBe(1);
		expect([...f.stored][0]).not.toContain(id(50));
	});
	it("retries Library registration against the adopted artifact without rendering or uploading again", async () => {
		const f = renderSetup();
		mocks.promote.mockRejectedValueOnce(new Error("registration unavailable"));
		await f.tick();
		expect(f.getRun()).toMatchObject({
			state: "SUCCEEDED",
			error: "LIBRARY_REGISTRATION_PENDING",
		});
		await f.tick();
		expect(mocks.promote).toHaveBeenCalledOnce();
		f.advance(EDITING_RECOVERY_RETRY_MS);
		await f.tick();
		expect(f.getRun()?.error).toBeNull();
		expect(mocks.render).toHaveBeenCalledOnce();
		expect(f.stored.size).toBe(1);
	});
	it("backs off a forbidden artifact recovery so another credential's queued run can finish", async () => {
		const f = renderSetup();
		const artifactToken = id(50);
		const originalKey = `clips/renders/${id(9)}/${artifactToken}/artifact.mp4`;
		f.stored.add(originalKey);
		Object.assign(f.getRun() ?? {}, {
			state: "VALIDATING",
			attempts: 3,
			leaseToken: id(51),
			leaseUntil: new Date(instant.getTime() - 1),
			pendingArtifactToken: artifactToken,
		});
		const denied = {
			...f.browser,
			headObject: vi.fn(async () => {
				throw Object.assign(new Error("Access denied"), { statusCode: 403 });
			}),
		};
		f.browserFor.mockImplementation(async (credentialId) =>
			credentialId === id(4) ? denied : f.browser,
		);
		await f.tick();
		f.addRun({
			...f.getRun(),
			id: id(55),
			state: "QUEUED",
			attempts: 0,
			generation: 2,
			outputCredentialId: id(44),
			pendingArtifactToken: null,
			leaseToken: null,
			leaseUntil: null,
			availableAt: instant,
			error: null,
		});
		await f.tick();
		expect(f.getRun(id(55))?.state).toBe("SUCCEEDED");
		expect(f.getRun(id(9))).toMatchObject({
			state: "VALIDATING",
			attempts: 3,
			pendingArtifactToken: artifactToken,
			availableAt: new Date(instant.getTime() + EDITING_RECOVERY_RETRY_MS),
		});
		expect(denied.headObject).toHaveBeenCalledOnce();
		f.browserFor.mockResolvedValue(f.browser);
		f.advance(EDITING_RECOVERY_RETRY_MS - 1);
		await f.tick();
		expect(f.getRun(id(9))?.state).toBe("VALIDATING");
		f.advance(1);
		await f.tick();
		expect(f.getRun(id(9))).toMatchObject({
			state: "SUCCEEDED",
			attempts: 3,
			pendingArtifactToken: null,
		});
		expect(mocks.render).toHaveBeenCalledOnce();
		expect(mocks.adopt.mock.calls.map(([input]) => input.runId)).toEqual([
			id(55),
			id(9),
		]);
		expect(mocks.download.mock.calls.at(-1)?.[0].key).toBe(originalKey);
	});
	it("waits for the media process to stop before confirming cancellation", async () => {
		vi.useFakeTimers();
		const f = renderSetup();
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let stopped!: () => void;
		let aborted = false;
		mocks.render.mockImplementationOnce(async ({ signal }) => {
			entered();
			await new Promise<void>((_resolve, reject) => {
				stopped = () => reject(new MediaOperationError("CANCELED"));
				signal.addEventListener("abort", () => {
					aborted = true;
				});
			});
		});
		const work = f.tick();
		await started;
		const canceledRun = f.getRun();
		if (!canceledRun) throw new Error("Expected a claimed render");
		Object.assign(canceledRun, {
			state: "CANCEL_REQUESTED",
			cancelRequestedAt: instant,
		});
		await vi.advanceTimersByTimeAsync(EDITING_HEARTBEAT_MS);
		expect(aborted).toBe(true);
		expect(f.getRun()?.state).toBe("CANCEL_REQUESTED");
		stopped();
		await work;
		expect(f.getRun()?.state).toBe("CANCELED");
		expect(mocks.adopt).not.toHaveBeenCalled();
	});
	it("does not adopt a late renderer after another worker has the lease", async () => {
		const f = renderSetup();
		mocks.render.mockImplementationOnce(async () => {
			const run = f.getRun();
			if (!run) throw new Error("Expected a claimed render");
			run.leaseToken = id(30);
			return {
				width: 1920,
				height: 1080,
				durationUs: 1_000_000,
				frameCount: 30,
				hasAudio: true,
				sha256,
				bytes: 20,
			};
		});
		await f.tick();
		expect(f.getRun()?.leaseToken).toBe(id(30));
		expect(mocks.adopt).not.toHaveBeenCalled();
		expect(f.stored.size).toBe(0);
	});
});
