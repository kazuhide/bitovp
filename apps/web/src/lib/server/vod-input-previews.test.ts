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
