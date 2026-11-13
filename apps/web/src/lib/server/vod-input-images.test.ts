import { createHash } from "node:crypto";
import {
	MAX_VOD_INPUT_IMAGE_BYTES,
	vodInputPreviewRequestSchema,
} from "@bitovp/core/vod-input-timeline";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	cancelVodInputPreviewTask,
	createVodInputPreviewTask,
	getVodInputPreviewTask,
} from "./vod-input-previews";

const mocks = vi.hoisted(() => ({
	context: {} as Record<string, unknown>,
	browser: vi.fn(),
	add: vi.fn(),
}));
vi.mock("./context", () => ({ getServerContext: async () => mocks.context }));
vi.mock("./storage", () => ({ browserForCredentialId: mocks.browser }));
vi.mock("./queue", () => ({
	getVodInputPreviewQueue: () => ({ add: mocks.add }),
}));
const sourceId = "00000000-0000-4000-8000-000000000001",
	outputId = "00000000-0000-4000-8000-000000000002",
	taskId = "00000000-0000-4000-8000-000000000003";
const input = {
	kind: "IMAGE_PREPARE",
	source: {
		key: "title",
		credentialId: sourceId,
		bucket: "input",
		objectKey: "title.png",
	},
	durationMs: 5000,
	output: { credentialId: outputId, bucket: "output", prefix: "test/" },
};
const identity = { size: 100, etag: '"image-v1"' };
let get: ReturnType<typeof vi.fn>,
	db: {
		vodInputPreviewTask: {
			create: ReturnType<typeof vi.fn>;
			findUnique: ReturnType<typeof vi.fn>;
			findFirst: ReturnType<typeof vi.fn>;
			updateMany: ReturnType<typeof vi.fn>;
		};
		$executeRaw: ReturnType<typeof vi.fn>;
	};
let source: {
		headObject?: ReturnType<typeof vi.fn>;
		getObject?: ReturnType<typeof vi.fn>;
		dispose: ReturnType<typeof vi.fn>;
	},
	output: {
		headObject?: ReturnType<typeof vi.fn>;
		getObject?: ReturnType<typeof vi.fn>;
		putObject?: ReturnType<typeof vi.fn>;
		dispose: ReturnType<typeof vi.fn>;
	};
let tenant: {
	organizationId: string;
	role: string;
	isImpersonating: boolean;
	actorUserId: null;
};
beforeEach(() => {
	vi.resetAllMocks();
	vi.stubEnv("MASTER_KEY", Buffer.alloc(32, 9).toString("base64"));
	tenant = {
		organizationId: sourceId,
		role: "OPERATOR",
		isImpersonating: false,
		actorUserId: null,
	};
	get = vi.fn(async (id: string) => ({ id, provider: "AWS_S3" }));
	source = {
		headObject: vi
			.fn()
			.mockResolvedValue({ ...identity, lastModified: "provider-advisory" }),
		getObject: vi.fn(),
		dispose: vi.fn(),
	};
	output = {
		headObject: vi.fn(),
		getObject: vi.fn(),
		putObject: vi.fn(),
		dispose: vi.fn(),
	};
	mocks.browser.mockImplementation(async (_ctx, id) =>
		id === sourceId ? source : output,
	);
	db = {
		vodInputPreviewTask: {
			create: vi.fn(async ({ data }) => ({
				...data,
				id: taskId,
				organizationId: sourceId,
				result: null,
				error: null,
				createdAt: new Date(),
			})),
			findUnique: vi.fn(),
			findFirst: vi.fn(),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
		$executeRaw: vi.fn(),
	};
	mocks.context = {
		tenant,
		credentials: { get },
		prisma: { ...db, $transaction: (fn: (tx: typeof db) => unknown) => fn(db) },
	};
});

describe("image preparation submission boundary", () => {
	it("seals provider identity before hashing and preserves a 24-hour tenant task without exposing private intent", async () => {
		const before = Date.now(),
			task = await createVodInputPreviewTask(input);
		const stored = db.vodInputPreviewTask.create.mock.calls[0]?.[0].data;
		expect(stored.request).toEqual({ ...input, sourceIdentity: identity });
		expect(stored.requestHash).toBe(
			createHash("sha256")
				.update(
					JSON.stringify(vodInputPreviewRequestSchema.parse(stored.request)),
				)
				.digest("hex"),
		);
		expect(stored.expiresAt.getTime()).toBeGreaterThanOrEqual(
			before + 24 * 3600_000,
		);
		expect(stored.expiresAt.getTime()).toBeLessThanOrEqual(
			Date.now() + 24 * 3600_000,
		);
		expect(source.headObject).toHaveBeenCalledWith({
			bucket: "input",
			key: "title.png",
		});
		expect(mocks.browser).toHaveBeenCalledWith(
			expect.anything(),
			sourceId,
			undefined,
			{ readTimeoutMs: 10_000 },
		);
		expect(source.getObject).not.toHaveBeenCalled();
		expect(output.putObject).not.toHaveBeenCalled();
		expect(source.dispose).toHaveBeenCalledOnce();
		expect(output.dispose).toHaveBeenCalledOnce();
		expect(task.kind).toBe("IMAGE_PREPARE");
		expect(task).not.toHaveProperty("request");
		expect(task).not.toHaveProperty("sourceIdentity");
		expect(mocks.add).toHaveBeenCalledWith(
			"vod-input-preview",
			{ taskId },
			expect.objectContaining({ jobId: taskId }),
		);
	});
	it.each([
		{ size: 100 },
		{ size: 100, etag: " " },
		{ size: 100, versionId: "null" },
		{ size: 0, etag: "valid" },
	])("refuses unverifiable observed identity %# before persistence", async (head) => {
		source.headObject?.mockResolvedValue(head);
		await expect(createVodInputPreviewTask(input)).rejects.toMatchObject({
			status: 422,
			code: "SOURCE_UNVERIFIED",
		});
		expect(db.vodInputPreviewTask.create).not.toHaveBeenCalled();
		expect(mocks.add).not.toHaveBeenCalled();
		expect(source.dispose).toHaveBeenCalledOnce();
	});
	it.each([
		{ size: 100, versionId: "immutable-version" },
		{ size: 100, generation: "1234" },
	])("accepts verifiable provider identity without inventing an ETag %#", async (head) => {
		source.headObject?.mockResolvedValue(head);
		await createVodInputPreviewTask(input);
		expect(
			db.vodInputPreviewTask.create.mock.calls[0]?.[0].data.request
				.sourceIdentity,
		).toEqual(head);
	});
	it("rejects over-limit source size and disposes its browser", async () => {
		source.headObject?.mockResolvedValue({
			...identity,
			size: MAX_VOD_INPUT_IMAGE_BYTES + 1,
		});
		await expect(createVodInputPreviewTask(input)).rejects.toMatchObject({
			status: 422,
			code: "SOURCE_READ_LIMIT",
		});
		expect(source.dispose).toHaveBeenCalledOnce();
		expect(mocks.add).not.toHaveBeenCalled();
	});
	it.each([
		"headObject",
		"getObject",
	] as const)("refuses a source without %s", async (method) => {
		source[method] = undefined;
		await expect(createVodInputPreviewTask(input)).rejects.toMatchObject({
			status: 422,
			code: "SOURCE_UNSUPPORTED",
		});
		expect(mocks.add).not.toHaveBeenCalled();
		expect(source.dispose).toHaveBeenCalledOnce();
	});
	it.each([
		"headObject",
		"getObject",
		"putObject",
	] as const)("refuses an output without %s", async (method) => {
		output[method] = undefined;
		await expect(createVodInputPreviewTask(input)).rejects.toMatchObject({
			status: 422,
			code: "IMAGE_OUTPUT_UNSUPPORTED",
		});
		expect(output.dispose).toHaveBeenCalledOnce();
		expect(mocks.add).not.toHaveBeenCalled();
	});
	it("refuses an unsupported output provider before opening its browser", async () => {
		get.mockImplementation(async (id: string) => ({
			id,
			provider: id === outputId ? "GCS_SERVICE_ACCOUNT" : "AWS_S3",
		}));
		await expect(createVodInputPreviewTask(input)).rejects.toMatchObject({
			status: 422,
			code: "IMAGE_OUTPUT_UNSUPPORTED",
		});
		expect(mocks.browser).not.toHaveBeenCalled();
	});
	it("sanitizes a provider HEAD failure without saving an uncertain source", async () => {
		source.headObject?.mockRejectedValue(
			new Error("https://private.invalid/?signed-secret"),
		);
		const promise = createVodInputPreviewTask(input);
		await expect(promise).rejects.toMatchObject({
			status: 502,
			code: "SOURCE_ACCESS_UNAVAILABLE",
		});
		await expect(promise).rejects.not.toThrow("signed-secret");
		expect(db.vodInputPreviewTask.create).not.toHaveBeenCalled();
		expect(source.dispose).toHaveBeenCalledOnce();
	});
	it("does not accept an identity supplied by the client", async () => {
		await expect(
			createVodInputPreviewTask({ ...input, sourceIdentity: identity }),
		).rejects.toMatchObject({ name: "ZodError" });
		expect(mocks.browser).not.toHaveBeenCalled();
		expect(mocks.add).not.toHaveBeenCalled();
	});
	it.each([
		sourceId,
		outputId,
	])("refuses a missing or foreign credential %s before using storage", async (missing) => {
		get.mockImplementation(async (id: string) =>
			id === missing ? null : { id, provider: "AWS_S3" },
		);
		await expect(createVodInputPreviewTask(input)).rejects.toMatchObject({
			status: 404,
			code: "SOURCE_CREDENTIAL_NOT_FOUND",
		});
		expect(mocks.browser).not.toHaveBeenCalled();
	});
	it.each([
		"viewer",
		"impersonating",
	])("refuses %s image work without a storage read", async (mode) => {
		if (mode === "viewer") tenant.role = "VIEWER";
		else tenant.isImpersonating = true;
		await expect(createVodInputPreviewTask(input)).rejects.toMatchObject({
			status: 403,
		});
		expect(get).not.toHaveBeenCalled();
		expect(mocks.browser).not.toHaveBeenCalled();
	});
	it.each([
		sourceId,
		outputId,
	])("revokes GET and cancellation after credential %s is deleted", async (missing) => {
		const row = {
			id: taskId,
			organizationId: sourceId,
			request: { ...input, sourceIdentity: identity },
			kind: "IMAGE_PREPARE",
			status: "PENDING",
			createdAt: new Date(),
			expiresAt: new Date(Date.now() + 60_000),
			requestHash: "a".repeat(64),
			stage: "QUEUED",
		};
		db.vodInputPreviewTask.findUnique.mockResolvedValue(row);
		get.mockImplementation(async (id: string) =>
			id === missing ? null : { id, provider: "AWS_S3" },
		);
		await expect(getVodInputPreviewTask(taskId)).rejects.toMatchObject({
			status: 404,
			code: "SOURCE_CREDENTIAL_NOT_FOUND",
		});
		await expect(cancelVodInputPreviewTask(taskId)).rejects.toMatchObject({
			status: 404,
			code: "SOURCE_CREDENTIAL_NOT_FOUND",
		});
		expect(db.vodInputPreviewTask.updateMany).not.toHaveBeenCalled();
	});
});
