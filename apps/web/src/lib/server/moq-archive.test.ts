import { randomUUID } from "node:crypto";
import {
	access,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getMoqArchive,
	putMoqArchive,
	removeMoqArchiveFile,
} from "./moq-archive";

const mocks = vi.hoisted(() => ({
	context: vi.fn(),
	run: vi.fn(),
	update: vi.fn(),
	execute: vi.fn(),
	probe: vi.fn(),
	normalize: vi.fn(),
	provenance: vi.fn(),
	lock: vi.fn(),
	audit: vi.fn(),
}));
vi.mock("./context", () => ({ getServerContext: mocks.context }));
vi.mock("./audit", () => ({ writeAuditLog: mocks.audit }));
vi.mock("./moq-heartbeat", () => ({ readMoqHeartbeatHistory: vi.fn() }));
vi.mock("./moq-archive-media", async (original) => ({
	...(await original<typeof import("./moq-archive-media")>()),
	probeMoqArchive: mocks.probe,
	normalizeMoqArchive: mocks.normalize,
}));
const ORG = "00000000-0000-4000-8000-000000000001",
	CHANNEL = "00000000-0000-4000-8000-000000000002",
	RUN = "00000000-0000-4000-8000-000000000003",
	SESSION = "00000000-0000-4000-8000-000000000004",
	ENCODING = "00000000-0000-4000-8000-000000000005",
	OUTPUT = "00000000-0000-4000-8000-000000000006";
const params = { id: CHANNEL, runId: RUN, sessionId: SESSION };
const bytes = Buffer.concat([
	Buffer.from([
		0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d,
	]),
	Buffer.from("received preview media"),
]);
const request = (
	body: Uint8Array = bytes,
	headers: Record<string, string> = {},
) =>
	new Request("http://test/archive", {
		method: "PUT",
		headers: {
			"Content-Type": "video/webm",
			"X-BitOVP-Moq-Duration-Ms": "10000",
			...headers,
		},
		body: Uint8Array.from(body),
	});
let root: string;
let row: Record<string, unknown>;
beforeEach(async () => {
	vi.resetAllMocks();
	root = await realpath(
		await mkdtemp(join(tmpdir(), "bitovp-moq-archive-test-")),
	);
	vi.stubEnv("BITOVP_MOQ_ARCHIVE_DIR", root);
	const now = new Date().toISOString();
	row = {
		id: RUN,
		organizationId: ORG,
		liveChannelId: CHANNEL,
		status: "STOPPED",
		bitmovinEncodingId: ENCODING,
		endedAt: new Date(),
		updatedAt: new Date(),
		stepLog: [
			{
				step: "encoding",
				kind: "CREATE_ENCODING",
				status: "DONE",
				payload: {},
				refs: {},
				resourceId: ENCODING,
			},
			{
				step: "output",
				kind: "CREATE_OUTPUT_MOQ",
				status: "DONE",
				payload: {},
				refs: {},
				resourceId: OUTPUT,
			},
			{
				step: "muxing",
				kind: "CREATE_MUXING_FMP4",
				status: "DONE",
				payload: {},
				refs: { encodingId: "encoding", outputId: "output" },
			},
		],
		moqObservations: {
			version: 1,
			sessions: [
				{
					id: SESSION,
					actor: "user:owner",
					startedAt: now,
					endedAt: now,
					samples: [],
					events: [],
					createdAt: now,
					updatedAt: now,
					archive: null,
				},
			],
		},
	};
	const prisma = {
		liveChannelRun: { findFirst: mocks.run, update: mocks.update },
		auditLog: { findMany: mocks.provenance },
		$queryRaw: mocks.lock,
		$executeRaw: mocks.execute,
	};
	Object.assign(prisma, {
		$transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
	});
	mocks.context.mockResolvedValue({
		tenant: {
			organizationId: ORG,
			role: "OPERATOR",
			actor: "user:owner",
			isImpersonating: false,
		},
		prisma,
	});
	mocks.run.mockImplementation(() => row);
	mocks.update.mockImplementation(({ data }) => {
		row = { ...row, ...data };
		return row;
	});
	mocks.execute.mockImplementation(
		(
			_query: TemplateStringsArray,
			serialized: string,
			updatedAt: Date,
			runId: string,
			organizationId: string,
		) => {
			if (runId !== row.id || organizationId !== row.organizationId) return 0;
			row = { ...row, moqObservations: JSON.parse(serialized), updatedAt };
			return 1;
		},
	);
	mocks.probe.mockResolvedValue(10_000);
	mocks.provenance.mockImplementation(({ where }) => [
		{
			organizationId: ORG,
			bitmovinAccountId: SESSION,
			response: {
				id: where.path === "/encoding/encodings" ? ENCODING : OUTPUT,
			},
		},
	]);
	mocks.normalize.mockImplementation(async (source: string, target: string) => {
		const { copyFile } = await import("node:fs/promises");
		await copyFile(source, target);
		return 10_000;
	});
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
});

describe("private received-preview WebM archives", () => {
	it("refuses a valid-looking WebM prefix when the declared body is longer", async () => {
		const short = request(bytes, {
			"Content-Length": String(bytes.length + 1),
		});
		const result = await putMoqArchive(short, params);
		expect(result.status).toBe(400);
		expect(mocks.normalize).not.toHaveBeenCalled();
		expect(mocks.execute).not.toHaveBeenCalled();
	});
	it("bounds admitted archive reads until their response is consumed or cancelled", async () => {
		expect((await putMoqArchive(request(), params)).status).toBe(200);
		const read = (method = "GET") =>
			getMoqArchive(new Request("http://test/archive", { method }), params);
		const first = await read();
		const second = await read();
		try {
			expect(first.status).toBe(200);
			expect(second.status).toBe(200);
			expect((await read("HEAD")).status).toBe(429);
			await first.body?.cancel();
			expect((await read("HEAD")).status).toBe(200);
			expect(Buffer.from(await second.arrayBuffer())).toEqual(bytes);
		} finally {
			if (!first.bodyUsed) await first.body?.cancel();
			if (!second.bodyUsed) await second.body?.cancel();
		}
	});
	it.each([
		"ADMIN",
		"OPERATOR",
	])("refuses GET, HEAD and Range archive reads during owner view-as for target role %s", async (role) => {
		expect((await putMoqArchive(request(), params)).status).toBe(200);
		const ctx = await mocks.context();
		ctx.tenant = { ...ctx.tenant, role, isImpersonating: true };
		mocks.run.mockClear();
		mocks.provenance.mockClear();
		const url = `http://test/api/live-channels/${CHANNEL}/runs/${RUN}/moq-observations/${SESSION}/archive?expectedOrganizationId=${ORG}`;
		for (const init of [
			{ method: "GET" },
			{ method: "HEAD" },
			{ method: "GET", headers: { Range: "bytes=0-3" } },
		]) {
			const response = await getMoqArchive(new Request(url, init), params);
			expect(response.status).toBe(403);
			expect(response.headers.get("content-type")).not.toBe("video/webm");
			expect(response.headers.has("content-range")).toBe(false);
		}
		expect(mocks.run).not.toHaveBeenCalled();
		expect(mocks.provenance).not.toHaveBeenCalled();
	});
	it("retains exact prior observation numbers when attaching a verified archive", async () => {
		const store = row.moqObservations as {
				sessions: { samples: Record<string, unknown>[] }[];
			},
			session = store.sessions[0];
		if (!session) throw new Error("Missing fixture session");
		const sample = {
			elapsedMs: 0,
			latencyMs: null,
			fps: 1.9994801351648572,
			bufferSeconds: null,
			droppedFrames: null,
			decodedFrames: null,
			presentedFrames: null,
			totalFrames: null,
			resolution: null,
		};
		session.samples = [{ ...sample }];
		// Reproduce the measured Prisma JSON model transport rounding. A text
		// parameter cast to jsonb must preserve the already-stored sample instead.
		mocks.update.mockImplementationOnce(({ data }) => {
			row = {
				...row,
				...data,
				moqObservations: JSON.parse(
					JSON.stringify(data.moqObservations, (_key, value) =>
						typeof value === "number" && !Number.isInteger(value)
							? Number(value.toPrecision(16))
							: value,
					),
				),
			};
			return row;
		});
		expect((await putMoqArchive(request(), params)).status).toBe(200);
		const saved = row.moqObservations as typeof store;
		expect(saved.sessions[0]?.samples).toEqual([sample]);
	});
	it("returns a safe failure when the scoped archive metadata write updates no run", async () => {
		mocks.execute.mockReturnValueOnce(0);
		const response = await putMoqArchive(request(), params);
		expect(response.status).toBe(503);
		expect(await response.text()).not.toContain(root);
		const saved = row.moqObservations as {
			sessions: { archive: unknown }[];
		};
		expect(saved.sessions[0]?.archive).toBeNull();
		expect(
			(await getMoqArchive(new Request("http://test/archive"), params)).status,
		).toBe(404);
	});
	it("permits only a single matching document binding on the native archive URL", async () => {
		await putMoqArchive(request(), params);
		const path = `http://test/api/live-channels/${CHANNEL}/runs/${RUN}/moq-observations/${SESSION}/archive`;
		for (const method of ["GET", "HEAD"]) {
			const response = await getMoqArchive(
				new Request(`${path}?expectedOrganizationId=${ORG}`, { method }),
				params,
			);
			expect(response.status).toBe(200);
			expect(Buffer.from(await response.arrayBuffer())).toEqual(
				method === "GET" ? bytes : Buffer.alloc(0),
			);
		}
		const partial = await getMoqArchive(
			new Request(`${path}?expectedOrganizationId=${ORG}`, {
				headers: { Range: "bytes=0-3" },
			}),
			params,
		);
		expect(partial.status).toBe(206);
		expect(Buffer.from(await partial.arrayBuffer())).toEqual(
			bytes.subarray(0, 4),
		);
		expect(
			(
				await getMoqArchive(
					new Request(`${path}?expectedOrganizationId=${SESSION}`),
					params,
				)
			).status,
		).toBe(409);
		for (const query of [
			`?expectedOrganizationId=${ORG}&expectedOrganizationId=${ORG}`,
			"?expectedOrganizationId=invalid",
			`?expectedOrganizationId=${ORG}&path=/tmp/private`,
		])
			expect(
				(await getMoqArchive(new Request(`${path}${query}`), params)).status,
			).toBe(400);
	});
	it("releases the session admission after an aggregate upload deadline even if cancellation hangs", async () => {
		vi.useFakeTimers();
		try {
			const cancel = vi.fn(() => new Promise<void>(() => {}));
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(bytes);
				},
				cancel,
			});
			const init = {
				method: "PUT",
				headers: {
					"Content-Type": "video/webm",
					"X-BitOVP-Moq-Duration-Ms": "10000",
				},
				body: stream,
				duplex: "half",
			};
			const stalled = new Request("http://test/archive", init);
			if (!stalled.body) throw new Error("Missing body");
			const read = vi.spyOn(stalled.body, "getReader"),
				pending = putMoqArchive(stalled, params);
			await vi.waitFor(() => expect(read).toHaveBeenCalled());
			await vi.advanceTimersByTimeAsync(10_001);
			expect((await pending).status).toBe(408);
			expect(cancel).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
		expect((await putMoqArchive(request(), params)).status).toBe(200);
	});
	it("caps work at two uploads per process and one per session before reading or probing rejected bodies", async () => {
		const store = row.moqObservations as {
			sessions: Record<string, unknown>[];
		};
		const original = store.sessions[0];
		if (!original) throw new Error("Missing fixture session");
		store.sessions = [
			original,
			{ ...original, id: OUTPUT },
			{ ...original, id: ENCODING },
		];
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		mocks.normalize.mockImplementation(
			async (source: string, target: string) => {
				await gate;
				const { copyFile } = await import("node:fs/promises");
				await copyFile(source, target);
				return 10_000;
			},
		);
		const pending: Promise<Response>[] = [];
		let duplicateResponse: Response | null = null,
			thirdResponse: Response | null = null;
		const duplicate = request(),
			third = request();
		if (!duplicate.body || !third.body) throw new Error("Missing fixture body");
		const duplicateRead = vi.spyOn(duplicate.body, "getReader"),
			thirdRead = vi.spyOn(third.body, "getReader");
		const bounded = (operation: Promise<Response>) =>
			Promise.race([
				operation,
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
			]);
		try {
			pending.push(putMoqArchive(request(), params));
			await vi.waitFor(() => expect(mocks.normalize).toHaveBeenCalledTimes(1));
			const duplicatePut = putMoqArchive(duplicate, params);
			pending.push(duplicatePut);
			duplicateResponse = await bounded(duplicatePut);
			pending.push(putMoqArchive(request(), { ...params, sessionId: OUTPUT }));
			await vi.waitFor(() =>
				expect(mocks.normalize.mock.calls.length).toBeGreaterThanOrEqual(2),
			);
			const thirdPut = putMoqArchive(third, { ...params, sessionId: ENCODING });
			pending.push(thirdPut);
			thirdResponse = await bounded(thirdPut);
		} finally {
			release();
			await Promise.allSettled(pending);
		}
		expect(duplicateResponse?.status).toBe(409);
		expect(thirdResponse?.status).toBe(429);
		expect(duplicateRead).not.toHaveBeenCalled();
		expect(thirdRead).not.toHaveBeenCalled();
		expect(mocks.normalize).toHaveBeenCalledTimes(2);
		expect(
			(await putMoqArchive(request(), { ...params, sessionId: ENCODING }))
				.status,
		).toBe(200);
	});
	it("keeps actor A's immutable archive when actor B submits an uppercase UUID alias", async () => {
		const lower = "abcdefab-0000-4000-8000-000000000004";
		const store = row.moqObservations as {
				sessions: Record<string, unknown>[];
			},
			original = store.sessions[0];
		if (!original) throw new Error("Missing fixture session");
		store.sessions = [{ ...original, id: lower }];
		expect(
			(await putMoqArchive(request(), { ...params, sessionId: lower })).status,
		).toBe(200);
		const current = row.moqObservations as {
			sessions: Record<string, unknown>[];
		};
		current.sessions.push({
			...original,
			id: lower.toUpperCase(),
			actor: "user:other",
		});
		const ctx = await mocks.context();
		ctx.tenant.actor = "user:other";
		expect(
			(
				await putMoqArchive(
					request(Buffer.concat([bytes, Buffer.from("actor B")])),
					{ ...params, sessionId: lower.toUpperCase() },
				)
			).status,
		).toBe(400);
		ctx.tenant.actor = "user:owner";
		const readBack = await getMoqArchive(new Request("http://test/archive"), {
			...params,
			sessionId: lower,
		});
		expect(readBack.status).toBe(200);
		expect(Buffer.from(await readBack.arrayBuffer())).toEqual(bytes);
	});
	it("cleans only owned archive and UUID temporary files after deletion, retaining unknown neighbors", async () => {
		const response = await putMoqArchive(request(), params),
			metadata = (await response.json()).archive;
		const directory = join(root, ORG, CHANNEL, RUN, SESSION),
			temporary = join(directory, `${randomUUID()}.part`),
			neighbor = join(directory, "notes.txt");
		await writeFile(temporary, bytes, { mode: 0o600 });
		await writeFile(neighbor, "keep", { mode: 0o600 });
		expect(await removeMoqArchiveFile(ORG, params, metadata)).toBe(true);
		await expect(access(temporary)).rejects.toThrow();
		await expect(access(neighbor)).resolves.toBeUndefined();
	});
	it("persists a verified archive and serves scoped Range/HEAD without a file path DTO", async () => {
		const uploaded = await putMoqArchive(request(), params);
		expect(uploaded.status).toBe(200);
		const body = await uploaded.json();
		expect(body.archive).toMatchObject({
			bytes: bytes.length,
			durationMs: 10_000,
			contentType: "video/webm",
		});
		expect(body.archive.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.stringify(body)).not.toContain(root);
		const partial = await getMoqArchive(
			new Request("http://test/archive", { headers: { Range: "bytes=0-3" } }),
			params,
		);
		expect(partial.status).toBe(206);
		expect(partial.headers.get("Content-Range")).toBe(
			`bytes 0-3/${bytes.length}`,
		);
		expect(Buffer.from(await partial.arrayBuffer())).toEqual(
			bytes.subarray(0, 4),
		);
		const head = await getMoqArchive(
			new Request("http://test/archive", { method: "HEAD" }),
			params,
		);
		expect(head.status).toBe(200);
		expect(head.headers.get("Cache-Control")).toBe("private, no-store");
		expect(await head.text()).toBe("");
		expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(root);
	});
	it("refuses a mismatched deletion proof and preserves the saved bytes", async () => {
		const uploaded = await putMoqArchive(request(), params);
		const metadata = (await uploaded.json()).archive;
		await expect(
			removeMoqArchiveFile(ORG, params, {
				...metadata,
				sha256: "0".repeat(64),
			}),
		).rejects.toThrow();
		const readBack = await getMoqArchive(
			new Request("http://test/archive"),
			params,
		);
		expect(readBack.status).toBe(200);
		expect(Buffer.from(await readBack.arrayBuffer())).toEqual(bytes);
	});
	it.each([
		"bytes=3-1",
		"bytes=999-",
		"bytes=0-1,3-4",
		"bytes=-0",
	])("refuses invalid ranges: %s", async (range) => {
		await putMoqArchive(request(), params);
		expect(
			(
				await getMoqArchive(
					new Request("http://test/archive", { headers: { Range: range } }),
					params,
				)
			).status,
		).toBe(416);
	});
	it("refuses missing sessions, another actor, stale flush and cross-tenant reads", async () => {
		expect(
			(await putMoqArchive(request(), { ...params, sessionId: OUTPUT })).status,
		).toBe(404);
		const ctx = await mocks.context();
		ctx.tenant.actor = "user:other";
		expect((await putMoqArchive(request(), params)).status).toBe(403);
		ctx.tenant.actor = "user:owner";
		row.endedAt = new Date(Date.now() - 600_001);
		expect((await putMoqArchive(request(), params)).status).toBe(409);
		row.organizationId = SESSION;
		expect(
			(await getMoqArchive(new Request("http://test/archive"), params)).status,
		).toBe(404);
	});
	it("checks content type, declared duration, actual byte budget, magic and probe duration", async () => {
		expect(
			(
				await putMoqArchive(
					request(bytes, { "Content-Type": "video/mp4" }),
					params,
				)
			).status,
		).toBe(415);
		expect(
			(
				await putMoqArchive(
					request(bytes, { "X-BitOVP-Moq-Duration-Ms": "90001" }),
					params,
				)
			).status,
		).toBe(400);
		expect(
			(await putMoqArchive(request(Buffer.alloc(16 * 1024 * 1024 + 1)), params))
				.status,
		).toBe(413);
		expect(
			(await putMoqArchive(request(Buffer.from("not webm")), params)).status,
		).toBe(400);
		mocks.normalize.mockRejectedValue(new Error("private raw probe error"));
		const response = await putMoqArchive(request(), params);
		expect(response.status).toBe(400);
		expect(await response.text()).not.toContain("private raw");
		expect(mocks.update).not.toHaveBeenCalled();
		expect(mocks.execute).not.toHaveBeenCalled();
	});
	it("refuses symlink roots/parents and tampered archive bytes", async () => {
		const link = `${root}-symlink`;
		await symlink(root, link);
		vi.stubEnv("BITOVP_MOQ_ARCHIVE_DIR", link);
		expect((await putMoqArchive(request(), params)).status).toBe(503);
		await rm(link);
		vi.stubEnv("BITOVP_MOQ_ARCHIVE_DIR", root);
		await symlink(tmpdir(), join(root, ORG));
		expect((await putMoqArchive(request(), params)).status).toBe(503);
		await rm(join(root, ORG));
		await putMoqArchive(request(), params);
		await writeFile(
			join(root, ORG, CHANNEL, RUN, SESSION, "archive.webm"),
			Buffer.alloc(bytes.length),
		);
		expect(
			(await getMoqArchive(new Request("http://test/archive"), params)).status,
		).toBe(404);
	});
});
