import { beforeEach, describe, expect, it, vi } from "vitest";

const db = {
	vodInputPreviewTask: {
		findFirst: vi.fn(),
		findUnique: vi.fn(),
		create: vi.fn(),
		updateMany: vi.fn(),
	},
	$executeRaw: vi.fn(),
};
const credentials = { get: vi.fn() };
const tenant = {
	organizationId: "00000000-0000-4000-8000-000000000001",
	role: "OPERATOR",
	isImpersonating: false,
	actorUserId: null,
};
const add = vi.fn();
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		tenant,
		credentials,
		prisma: { ...db, $transaction: (fn: (tx: typeof db) => unknown) => fn(db) },
	}),
}));
vi.mock("@/lib/server/queue", () => ({
	getVodInputPreviewQueue: () => ({ add }),
}));

import {
	createVodInputPreviewTask,
	getVodInputPreviewTask,
	toVodInputPreviewDto,
} from "./vod-input-previews";

const id = "00000000-0000-4000-8000-000000000002";
const probeRequest = {
	kind: "PROBE",
	sources: [
		{ key: "a", credentialId: id, bucket: "input", objectKey: "a.mov" },
	],
};
const facts = [
	{
		key: "a",
		durationMs: 5000,
		video: {
			streamIndex: 0,
			width: 1920,
			height: 1080,
			displayAspectRatio: { num: 16, den: 9 },
		},
		audio: null,
		identity: { size: 100, etag: '"one"' },
	},
];
const row = {
	id,
	organizationId: tenant.organizationId,
	kind: "PROBE",
	status: "SUCCEEDED",
	stage: "READY",
	request: probeRequest,
	result: { sources: facts },
	requestHash: "a".repeat(64),
	error: null,
	artifactPath: "/private/path",
	createdAt: new Date(),
	expiresAt: new Date(Date.now() + 60000),
};

function longSourceAudition() {
	const base = facts[0];
	if (!base) throw new Error("Expected a source fixture");
	const source = {
		...base,
		durationMs: 4000,
		video: { ...base.video, durationMs: 4000 },
		audio: {
			streamIndex: 1,
			sampleRate: 48000,
			channels: 2,
			durationMs: 18000,
		},
	};
	const clip = { id, sourceKey: "a", startMs: 0, inMs: 0 };
	return {
		probe: { ...row, result: { sources: [source] } },
		request: {
			kind: "PREVIEW" as const,
			probeId: id,
			document: {
				schemaVersion: 2 as const,
				id,
				audioEnabled: true,
				durationMs: 18000,
				videoClips: [{ ...clip, outMs: 4000 }],
				audioClips: [{ ...clip, outMs: 18000 }],
			},
			range: { startMs: 0, durationMs: 18000 },
			sourcePreviewKey: "a",
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	tenant.role = "OPERATOR";
	tenant.isImpersonating = false;
	vi.stubEnv("MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
	credentials.get.mockResolvedValue({ id, provider: "AWS_S3" });
	db.vodInputPreviewTask.findFirst.mockResolvedValue(null);
	db.vodInputPreviewTask.create.mockImplementation(async ({ data }) => ({
		...row,
		...data,
		id,
		createdAt: new Date(),
	}));
	add.mockResolvedValue(undefined);
});

describe("manual VOD preview service", () => {
	it("allows a natural source audition beyond ten seconds of trailing video while edited programs retain the native gap limit", async () => {
		const fixture = longSourceAudition();
		db.vodInputPreviewTask.findUnique.mockResolvedValue(fixture.probe);
		const { sourcePreviewKey: _sourcePreviewKey, ...edited } = fixture.request;
		await expect(createVodInputPreviewTask(edited)).rejects.toMatchObject({
			code: "TIMELINE_GAP_TOO_LONG",
		});
		expect(add).not.toHaveBeenCalled();
		const task = await createVodInputPreviewTask(fixture.request);
		expect(task).toMatchObject({ kind: "PREVIEW", status: "PENDING" });
		expect(
			db.vodInputPreviewTask.create.mock.calls[0]?.[0].data.request,
		).toEqual(fixture.request);
		expect(add).toHaveBeenCalledTimes(1);
	});
	it.each([
		"trim",
		"other source",
		"false duration",
	] as const)("rejects a source-audition exception for %s before queueing", async (change) => {
		const fixture = longSourceAudition();
		db.vodInputPreviewTask.findUnique.mockResolvedValue(fixture.probe);
		const request = fixture.request;
		if (change === "trim") {
			const audio = request.document.audioClips[0];
			if (!audio) throw new Error("Expected an audio fixture");
			audio.inMs = 1000;
		} else if (change === "other source") request.sourcePreviewKey = "foreign";
		else request.document.durationMs = 19000;
		await expect(createVodInputPreviewTask(request)).rejects.toMatchObject({
			code: "SOURCE_PREVIEW_INVALID",
		});
		expect(add).not.toHaveBeenCalled();
		expect(db.vodInputPreviewTask.create).not.toHaveBeenCalled();
	});
	it("creates a CPU-only task using registered storage refs without requiring local LLM", async () => {
		const task = await createVodInputPreviewTask(probeRequest);
		expect(task.kind).toBe("PROBE");
		expect(task.status).toBe("PENDING");
		expect(add).toHaveBeenCalledWith(
			"vod-input-preview",
			{ taskId: id },
			expect.objectContaining({ jobId: id }),
		);
		expect(JSON.stringify(task)).not.toContain("/private/path");
	});
	it("keeps each in-flight probe private so cleanup in one tab cannot cancel another", async () => {
		await createVodInputPreviewTask(probeRequest);
		await createVodInputPreviewTask(probeRequest);
		expect(db.vodInputPreviewTask.create).toHaveBeenCalledTimes(2);
		expect(db.vodInputPreviewTask.findFirst).not.toHaveBeenCalled();
	});
	it("rejects a viewer and impersonated session before reading storage or queuing", async () => {
		tenant.role = "VIEWER";
		await expect(createVodInputPreviewTask(probeRequest)).rejects.toMatchObject(
			{ status: 403 },
		);
		tenant.role = "ADMIN";
		tenant.isImpersonating = true;
		await expect(createVodInputPreviewTask(probeRequest)).rejects.toMatchObject(
			{ status: 403 },
		);
		expect(credentials.get).not.toHaveBeenCalled();
		expect(add).not.toHaveBeenCalled();
	});
	it("rejects range/audio mismatch against trusted probe facts", async () => {
		db.vodInputPreviewTask.findUnique.mockResolvedValue(row);
		await expect(
			createVodInputPreviewTask({
				kind: "PREVIEW",
				probeId: id,
				document: {
					schemaVersion: 1,
					id,
					audioEnabled: true,
					clips: [{ id, sourceKey: "a", inMs: 0, outMs: 6000 }],
				},
				range: { startMs: 0, durationMs: 1000 },
			}),
		).rejects.toMatchObject({ code: "SOURCE_RANGE_INVALID" });
		expect(add).not.toHaveBeenCalled();
	});
	it("accepts independent audio over a silent video without requiring video geometry on the audio file", async () => {
		const voiceId = "00000000-0000-4000-8000-000000000003";
		const request = {
			kind: "PREVIEW",
			probeId: id,
			document: {
				schemaVersion: 2,
				id,
				audioEnabled: true,
				durationMs: 5000,
				videoClips: [{ id, sourceKey: "a", startMs: 0, inMs: 0, outMs: 5000 }],
				audioClips: [
					{ id: voiceId, sourceKey: "voice", startMs: 0, inMs: 0, outMs: 5000 },
				],
			},
			range: { startMs: 0, durationMs: 5000 },
		};
		const probe = {
			...row,
			request: {
				...probeRequest,
				sources: [
					...probeRequest.sources,
					{
						key: "voice",
						credentialId: id,
						bucket: "input",
						objectKey: "voice.wav",
					},
				],
			},
			result: {
				sources: [
					...facts,
					{
						key: "voice",
						durationMs: 5000,
						video: null,
						audio: { streamIndex: 0, sampleRate: 48000, channels: 2 },
						identity: { size: 100, etag: '"voice"' },
					},
				],
			},
		};
		db.vodInputPreviewTask.findUnique.mockResolvedValue(probe);
		const task = await createVodInputPreviewTask(request);
		expect(task).toMatchObject({ kind: "PREVIEW", status: "PENDING" });
		expect(
			db.vodInputPreviewTask.create.mock.calls[0]?.[0].data.request,
		).toEqual(request);
		expect(add).toHaveBeenCalledTimes(1);
	});
	it("allows an audio-only source audition with a neutral video canvas", async () => {
		const probe = {
			...row,
			result: {
				sources: [
					{
						key: "a",
						durationMs: 5000,
						video: null,
						audio: { streamIndex: 0, sampleRate: 48000, channels: 2 },
						identity: { size: 100, etag: '"voice"' },
					},
				],
			},
		};
		db.vodInputPreviewTask.findUnique.mockResolvedValue(probe);
		const task = await createVodInputPreviewTask({
			kind: "PREVIEW",
			probeId: id,
			document: {
				schemaVersion: 2,
				id,
				audioEnabled: true,
				durationMs: 5000,
				videoClips: [],
				audioClips: [{ id, sourceKey: "a", startMs: 0, inMs: 0, outMs: 5000 }],
			},
			range: { startMs: 0, durationMs: 1000 },
		});
		expect(task.kind).toBe("PREVIEW");
		expect(add).toHaveBeenCalledTimes(1);
	});
	it("does not expose a derived task once its source credential is deleted", async () => {
		db.vodInputPreviewTask.findUnique.mockResolvedValue(row);
		credentials.get.mockResolvedValue(null);
		await expect(getVodInputPreviewTask(id)).rejects.toMatchObject({
			status: 404,
		});
	});
	it("requires fresh display geometry before serving or reusing a legacy preview", async () => {
		const legacyProbe = {
			...row,
			result: {
				sources: facts.map((source) => ({
					...source,
					video: { streamIndex: 0, width: 720, height: 576 },
				})),
			},
		};
		const request = {
			kind: "PREVIEW",
			probeId: id,
			document: {
				schemaVersion: 1,
				id,
				audioEnabled: false,
				clips: [{ id, sourceKey: "a", inMs: 0, outMs: 1000 }],
			},
			range: { startMs: 0, durationMs: 1000 },
		};
		const artifactId = "00000000-0000-4000-8000-000000000003";
		const artifact = {
			...row,
			id: artifactId,
			kind: "PREVIEW",
			request,
			result: {
				preview: {
					startMs: 0,
					durationMs: 1000,
					size: 100,
					sha256: "a".repeat(64),
				},
			},
		};
		db.vodInputPreviewTask.findUnique.mockImplementation(async ({ where }) =>
			where.id === id ? legacyProbe : artifact,
		);
		db.vodInputPreviewTask.findFirst.mockResolvedValue(artifact);
		await expect(createVodInputPreviewTask(request)).rejects.toMatchObject({
			status: 409,
			code: "SOURCE_PROBE_NOT_READY",
		});
		expect(db.vodInputPreviewTask.findFirst).not.toHaveBeenCalled();
		await expect(getVodInputPreviewTask(artifactId)).rejects.toMatchObject({
			status: 409,
			code: "SOURCE_PROBE_NOT_READY",
		});
	});
	it("keeps enqueue failure terminal and removes private columns from public DTOs", async () => {
		add.mockRejectedValue(
			new Error("redis unavailable with private connection"),
		);
		await expect(createVodInputPreviewTask(probeRequest)).rejects.toMatchObject(
			{ code: "PREVIEW_QUEUE_UNAVAILABLE", status: 503 },
		);
		expect(db.vodInputPreviewTask.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "FAILED" }),
			}),
		);
		expect(toVodInputPreviewDto(row)).toEqual(
			expect.objectContaining({ id, result: { sources: facts } }),
		);
		expect(toVodInputPreviewDto(row)).not.toHaveProperty("artifactPath");
	});
});
