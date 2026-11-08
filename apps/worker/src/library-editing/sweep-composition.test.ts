import { toCompositionDocument } from "@bitovp/core";
import { matchesWhere } from "@bitovp/core/testing";
import type { AppPrismaClient } from "@bitovp/db";
import type { ObjectStorageBrowser } from "@bitovp/storage";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	download: vi.fn(),
	probe: vi.fn(),
	render: vi.fn(),
	legacy: vi.fn(),
	adopt: vi.fn(),
	promote: vi.fn(),
	reconcile: vi.fn(),
}));
vi.mock("./media", async (importOriginal) => ({
	...(await importOriginal<typeof import("./media")>()),
	downloadPinnedEditingMedia: mocks.download,
	probeEditingMedia: mocks.probe,
}));
vi.mock("./render", () => ({
	renderEditingRecipe: mocks.legacy,
	renderCompositionRecipe: mocks.render,
	editingRenderCanvas: () => ({ width: 640, height: 360 }),
}));
vi.mock("./derivatives", () => ({
	adoptEditingArtifact: mocks.adopt,
	promoteEditingArtifact: mocks.promote,
	LIBRARY_REGISTRATION_PENDING: "LIBRARY_REGISTRATION_PENDING",
}));
vi.mock("../library/captured-bindings", () => ({
	reconcileCapturedBindings: mocks.reconcile,
}));

import { MediaOperationError } from "./process";
import { createLibraryEditingSweep, EDITING_RECOVERY_RETRY_MS } from "./sweep";

const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
afterEach(() => {
	vi.resetAllMocks();
	vi.restoreAllMocks();
});
function setup() {
	let instant = new Date("2026-11-02T00:00:00Z");
	const facts = {
		width: 320,
		height: 180,
		frameCount: 60,
		durationUs: 2_000_000,
		fps: { num: 30, den: 1 },
		hasAudio: false,
		probe: {
			streams: [
				{
					codec_type: "video",
					codec_name: "h264",
					codec_tag_string: "avc1",
					pix_fmt: "yuv420p",
					field_order: "progressive",
					sample_aspect_ratio: "1:1",
					r_frame_rate: "30/1",
					avg_frame_rate: "30/1",
					start_time: "0",
					color_transfer: "bt709",
					color_primaries: "bt709",
					color_space: "bt709",
					width: 320,
					height: 180,
					duration: "2",
					nb_frames: "60",
				},
			],
			format: { format_name: "mov,mp4" },
		},
	};
	const media = (n: number) => ({
		id: id(n),
		sourceId: id(20 + n),
		organizationId: id(10),
		state: "READY",
		attempts: 0,
		sha256: String(n).repeat(64),
		width: 320,
		height: 180,
		probe: facts.probe,
		timeMap: {
			id: id(n),
			mediaVersionId: id(n),
			kind: "CFR",
			sourceStartUs: 0,
			sourceEndUs: 2_000_000,
			editingStartFrame: 0,
			editingEndFrame: 60,
			fps: { num: 30, den: 1 },
		},
		storage: {
			source: { credentialId: id(5), bucket: "b", key: `original-${n}.mp4` },
			prepared: {
				credentialId: id(5),
				bucket: "b",
				key: `prepared-${n}.mp4`,
				size: 20,
				expect: { etag: `prepared-${n}` },
			},
			output: { credentialId: id(5), bucket: "b", prefix: "clips" },
		},
	});
	const primary = media(1),
		extra = media(2);
	const image = {
		id: id(4),
		organizationId: id(10),
		projectId: id(11),
		sha256: "a".repeat(64),
		size: 20n,
		width: 1,
		height: 1,
		storage: {
			credentialId: id(5),
			bucket: "b",
			key: "logo.png",
			size: 20,
			expect: { etag: "logo" },
		},
	};
	const document = toCompositionDocument({
		schemaVersion: 1,
		mediaVersionId: id(1),
		timeMapId: id(1),
		analysisRevisionId: null,
		locale: "ja",
		sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
		canvas: { width: 1080, height: 1920 },
		fps: { num: 30, den: 1 },
		clips: [
			{
				id: id(3),
				sourceInUs: 0,
				durationFrames: 30,
				timelineStartFrame: 0,
				framing: [{ fromFrame: 0, toFrame: 30, mode: "FIT", origin: "MANUAL" }],
				audio: { mode: "MUTE" },
			},
		],
	});
	document.canvas = { width: 1080, height: 1350 };
	document.sources = [{ mediaVersionId: id(2), timeMapId: id(2) }];
	document.imageAssets = [{ id: id(4) }];
	document.overlays = [
		{
			id: id(4),
			kind: "IMAGE",
			assetId: id(4),
			fromFrame: 0,
			toFrame: 30,
			rect: { x: 0, y: 0, w: 0.1, h: 0.1 },
			opacity: 1,
			zIndex: 1,
		},
	];
	const run: Record<string, unknown> = {
		id: id(9),
		organizationId: id(10),
		projectId: id(11),
		revisionId: id(12),
		state: "QUEUED",
		attempts: 0,
		availableAt: instant,
		leaseToken: null,
		leaseUntil: null,
		pendingArtifactToken: null,
		cancelRequestedAt: null,
		generation: 1,
		profile: { kind: "PREVIEW" },
		outputCredentialId: id(5),
		outputBucket: "b",
		outputPrefix: "clips",
		error: null,
	};
	const mutate = (data: Record<string, unknown>) => {
		for (const [key, value] of Object.entries(data))
			run[key] =
				value && typeof value === "object" && "increment" in value
					? Number(run[key]) + Number(value.increment)
					: value;
	};
	const db = {
		libraryMediaVersion: {
			updateMany: vi.fn().mockResolvedValue({ count: 0 }),
			findMany: vi.fn(async ({ where }) => (where.id ? [extra] : [])),
		},
		libraryImageAsset: { findMany: vi.fn().mockResolvedValue([image]) },
		libraryEvidenceReceipt: { findMany: vi.fn().mockResolvedValue([]) },
		renderRun: {
			findMany: vi.fn(async ({ where }) =>
				matchesWhere(run, where) ? [run] : [],
			),
			findUnique: vi.fn(async () => run),
			updateMany: vi.fn(async ({ where, data }) => {
				if (!matchesWhere(run, where)) return { count: 0 };
				mutate(data);
				return { count: 1 };
			}),
		},
		editProject: {
			findUnique: vi.fn(async () => ({
				id: id(11),
				organizationId: id(10),
				mediaVersion: primary,
				archived: false,
			})),
		},
		editRevision: {
			findUnique: vi.fn(async () => ({
				id: id(12),
				organizationId: id(10),
				projectId: id(11),
				document,
			})),
		},
		sceneAnalysisRevision: { findFirst: vi.fn().mockResolvedValue(null) },
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
			return { size: 20, etag: "output" };
		}),
		dispose: vi.fn(),
	};
	const browserFor = vi.fn(async () => browser);
	mocks.download.mockImplementation(async ({ key }) => ({
		sha256:
			key === "logo.png"
				? image.sha256
				: key === "prepared-2.mp4"
					? extra.sha256
					: primary.sha256,
		bytes: 20,
		identity: { size: 20, etag: key },
	}));
	mocks.probe.mockImplementation(async ({ sourcePath }) =>
		sourcePath.endsWith("artifact.mp4")
			? {
					...facts,
					width: 512,
					height: 640,
					frameCount: 30,
					durationUs: 1_000_000,
					hasAudio: true,
				}
			: facts,
	);
	mocks.render.mockResolvedValue({
		width: 512,
		height: 640,
		frameCount: 30,
		durationUs: 1_000_000,
		hasAudio: true,
		sha256: "b".repeat(64),
		bytes: 20,
	});
	mocks.adopt.mockImplementation(async () => {
		mutate({
			state: "SUCCEEDED",
			leaseToken: null,
			leaseUntil: null,
			pendingArtifactToken: null,
			error: null,
		});
		return id(15);
	});
	mocks.reconcile.mockResolvedValue({ created: 0, preserved: 0 });
	const tick = createLibraryEditingSweep({
		canClaim: async () => true,
		prisma: db as unknown as AppPrismaClient,
		browserFor,
		now: () => instant,
	});
	return {
		primary,
		extra,
		image,
		document,
		run,
		db,
		browser,
		browserFor,
		tick,
		stored,
		advance: () => {
			instant = new Date(instant.getTime() + EDITING_RECOVERY_RETRY_MS);
		},
	};
}
describe("durable composition rendering", () => {
	it("downloads every hash-pinned source and image and dispatches V2 without legacy rendering", async () => {
		const f = setup();
		await f.tick();
		expect(f.run.state).toBe("SUCCEEDED");
		expect(mocks.legacy).not.toHaveBeenCalled();
		expect(mocks.render).toHaveBeenCalledOnce();
		expect(
			mocks.download.mock.calls.map(([input]) => [
				input.key,
				input.expectedSha256,
			]),
		).toEqual([
			["prepared-1.mp4", f.primary.sha256],
			["prepared-2.mp4", f.extra.sha256],
			["logo.png", f.image.sha256],
		]);
		expect(mocks.render.mock.calls[0]?.[0]).toMatchObject({
			plan: { compilerVersion: "content-composition-v2", durationFrames: 30 },
			sources: [{ mediaVersionId: id(1) }, { mediaVersionId: id(2) }],
			images: [{ assetId: id(4) }],
			mode: "PREVIEW",
		});
	});
	it.each([
		["SOURCE_DOWNLOAD", "PREPARING"],
		["SOURCE_PROBE", "PREPARING"],
		["COMPOSITION_RENDER", "RENDERING"],
		["ARTIFACT_UPLOAD", "VALIDATING"],
	] as const)("captures a redacted %s failure without changing durable handling", async (operation, stage) => {
		const f = setup();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const secret = "private-caption-and-storage-token";
		const error = new MediaOperationError(
			"PROCESS_FAILED",
			secret,
			`No such filter: '${secret}' /private/storage.mp4`,
		);
		if (operation === "SOURCE_DOWNLOAD")
			mocks.download.mockRejectedValueOnce(error);
		else if (operation === "SOURCE_PROBE")
			mocks.probe.mockRejectedValueOnce(error);
		else if (operation === "COMPOSITION_RENDER")
			mocks.render.mockRejectedValueOnce(error);
		else f.browser.putObject = vi.fn().mockRejectedValueOnce(error);
		await f.tick();
		expect(warn).toHaveBeenCalledOnce();
		const line = warn.mock.calls[0]?.[0];
		expect(typeof line).toBe("string");
		expect(JSON.parse(String(line))).toMatchObject({
			event: "library_render_failed",
			runId: id(9),
			organizationId: id(10),
			projectId: id(11),
			revisionId: id(12),
			schemaVersion: 2,
			stage,
			operation,
			errorClass: "MediaOperationError",
			errorCode: "PROCESS_FAILED",
			processSignature: "FILTER_GRAPH",
			elapsedMs: expect.any(Number),
		});
		expect(String(line)).not.toContain(secret);
		expect(String(line)).not.toContain("/private/storage.mp4");
		expect(f.run).toMatchObject(
			operation === "ARTIFACT_UPLOAD"
				? { state: "VALIDATING", error: "ARTIFACT_ADOPTION_PENDING" }
				: { state: "FAILED", error: "RENDER_FAILED" },
		);
		expect(mocks.adopt).not.toHaveBeenCalled();
	});
	it.each([
		false,
		true,
	])("contains diagnostic sink failures while preserving cancellation=%s", async (cancel) => {
		const f = setup();
		vi.spyOn(console, "warn").mockImplementation(() => {
			throw new Error("diagnostic sink unavailable");
		});
		mocks.render.mockImplementationOnce(async () => {
			if (cancel) f.run.state = "CANCEL_REQUESTED";
			throw new MediaOperationError(cancel ? "CANCELED" : "PROCESS_FAILED");
		});
		await f.tick();
		expect(f.run).toMatchObject(
			cancel
				? { state: "CANCELED", error: null }
				: { state: "FAILED", error: "RENDER_FAILED" },
		);
		expect(mocks.adopt).not.toHaveBeenCalled();
	});
	it("rejects tenant or readiness drift before downloading or adopting", async () => {
		const f = setup();
		f.extra.organizationId = id(20);
		await f.tick();
		expect(f.run.state).toBe("FAILED");
		expect(mocks.download).not.toHaveBeenCalled();
		expect(mocks.adopt).not.toHaveBeenCalled();
	});
	it("propagates changed pinned bytes without rendering or adopting", async () => {
		const f = setup();
		mocks.download.mockRejectedValueOnce(
			new MediaOperationError("SOURCE_CHANGED"),
		);
		await f.tick();
		expect(f.run).toMatchObject({ state: "FAILED", error: "SOURCE_CHANGED" });
		expect(mocks.render).not.toHaveBeenCalled();
		expect(mocks.adopt).not.toHaveBeenCalled();
	});
	it("recovers 4:5 output using exact V2 canvas without downloading unavailable prepared sources", async () => {
		const f = setup();
		mocks.adopt.mockRejectedValueOnce(new Error("DB unavailable"));
		await f.tick();
		expect(f.run.state).toBe("VALIDATING");
		const key = [...f.stored][0];
		const originalEvidence = mocks.adopt.mock.calls[0]?.[0].evidence;
		expect(key).toContain(`/${originalEvidence.recipeHash}/`);
		mocks.download.mockImplementation(async ({ key: requested }) => {
			if (requested !== key) throw new MediaOperationError("SOURCE_CHANGED");
			return {
				sha256: "b".repeat(64),
				bytes: 20,
				identity: { size: 20, etag: "output" },
			};
		});
		f.advance();
		await f.tick();
		expect(f.run.state).toBe("SUCCEEDED");
		expect(mocks.render).toHaveBeenCalledOnce();
		expect(mocks.download.mock.calls.at(-1)?.[0].key).toBe(key);
		expect(mocks.adopt.mock.calls[1]?.[0].evidence).toMatchObject({
			recipeHash: originalEvidence.recipeHash,
			storage: { key },
		});
	});
	it.each([
		"unbound",
		"different-recipe",
	] as const)("preserves a %s V2 orphan without adopting it when the render budget is exhausted", async (kind) => {
		const f = setup();
		const token = id(50);
		const oldKey =
			kind === "unbound"
				? `clips/renders/${id(9)}/${token}/artifact.mp4`
				: `clips/renders/${id(9)}/${token}/recipes/${"f".repeat(64)}/artifact.mp4`;
		f.stored.add(oldKey);
		Object.assign(f.run, {
			state: "VALIDATING",
			attempts: 3,
			leaseToken: id(51),
			leaseUntil: new Date("2026-11-01T00:00:00Z"),
			pendingArtifactToken: token,
		});
		await f.tick();
		expect(f.run).toMatchObject({
			state: "FAILED",
			attempts: 3,
			error: "RENDER_ATTEMPTS_EXHAUSTED",
		});
		expect(f.stored).toEqual(new Set([oldKey]));
		expect(mocks.download).not.toHaveBeenCalled();
		expect(mocks.render).not.toHaveBeenCalled();
		expect(mocks.adopt).not.toHaveBeenCalled();
	});
	it("renders the current V2 recipe with the remaining budget and retains the prior recipe's bytes", async () => {
		const f = setup();
		const token = id(50);
		const oldRecipe = "f".repeat(64);
		const oldKey = `clips/renders/${id(9)}/${token}/recipes/${oldRecipe}/artifact.mp4`;
		f.stored.add(oldKey);
		Object.assign(f.run, {
			state: "VALIDATING",
			attempts: 2,
			leaseToken: id(51),
			leaseUntil: new Date("2026-11-01T00:00:00Z"),
			pendingArtifactToken: token,
		});
		await f.tick();
		expect(f.run).toMatchObject({ state: "SUCCEEDED", attempts: 3 });
		expect(mocks.render).toHaveBeenCalledOnce();
		expect(mocks.adopt).toHaveBeenCalledOnce();
		const evidence = mocks.adopt.mock.calls[0]?.[0].evidence;
		expect(evidence.recipeHash).not.toBe(oldRecipe);
		expect(evidence.storage.key).toContain(`/${evidence.recipeHash}/`);
		expect(evidence.storage.key).not.toBe(oldKey);
		expect(f.stored).toEqual(new Set([oldKey, evidence.storage.key]));
		expect(mocks.download.mock.calls.map(([input]) => input.key)).not.toContain(
			oldKey,
		);
	});
	it("retains a newly uploaded V2 recipe object without adoption after cancellation", async () => {
		const f = setup();
		const putObject = f.browser.putObject;
		if (!putObject) throw new Error("Expected fixture upload support");
		vi.mocked(putObject).mockImplementation(async ({ key }) => {
			f.stored.add(key);
			f.run.state = "CANCEL_REQUESTED";
			f.run.cancelRequestedAt = new Date("2026-11-02T00:00:00Z");
		});
		await f.tick();
		expect(f.run.state).toBe("CANCELED");
		expect(f.stored.size).toBe(1);
		expect(mocks.adopt).not.toHaveBeenCalled();
	});
	it("retains a newly uploaded V2 recipe object without adoption after lease loss", async () => {
		const f = setup();
		const putObject = f.browser.putObject;
		if (!putObject) throw new Error("Expected fixture upload support");
		vi.mocked(putObject).mockImplementation(async ({ key }) => {
			f.stored.add(key);
			f.run.leaseToken = id(99);
		});
		await f.tick();
		expect(f.run).toMatchObject({ state: "VALIDATING", leaseToken: id(99) });
		expect(f.stored.size).toBe(1);
		expect(mocks.adopt).not.toHaveBeenCalled();
	});
	it("rejects a recovered artifact at the wrong aspect", async () => {
		const f = setup();
		mocks.adopt.mockRejectedValueOnce(new Error("DB unavailable"));
		await f.tick();
		mocks.probe.mockResolvedValue({
			...(await mocks.probe({ sourcePath: "artifact.mp4" })),
			width: 640,
			height: 360,
		});
		f.advance();
		await f.tick();
		expect(f.run.state).not.toBe("SUCCEEDED");
		expect(mocks.adopt).toHaveBeenCalledOnce();
	});
	it("repairs a captured-binding crash gap in bounded cursor pages after rendering", async () => {
		const f = setup();
		f.db.libraryEvidenceReceipt.findMany.mockResolvedValueOnce([
			{ id: id(40), organizationId: id(10), sourceId: id(21) },
		]);
		await f.tick();
		expect(f.run.state).toBe("SUCCEEDED");
		expect(mocks.reconcile).toHaveBeenCalledWith({
			prisma: expect.anything(),
			organizationId: id(10),
			sourceId: id(21),
		});
		await f.tick();
		expect(
			f.db.libraryEvidenceReceipt.findMany.mock.calls[1]?.[0],
		).toMatchObject({
			where: {
				id: { gt: id(40) },
				kind: "NORMALIZATION_CAPTURE",
				mediaVersion: { state: "READY" },
			},
			orderBy: { id: "asc" },
			take: 10,
		});
	});
	it("does not let one failed binding prevent later sources in the same bounded page", async () => {
		const f = setup();
		f.db.libraryEvidenceReceipt.findMany.mockResolvedValueOnce([
			{ id: id(40), organizationId: id(10), sourceId: id(21) },
			{ id: id(41), organizationId: id(10), sourceId: id(22) },
		]);
		mocks.reconcile.mockRejectedValueOnce(new Error("receipt mismatch"));
		await expect(f.tick()).rejects.toThrow("EDITING_SWEEP_FAILED");
		expect(f.run.state).toBe("SUCCEEDED");
		expect(mocks.reconcile).toHaveBeenCalledTimes(2);
	});
});
