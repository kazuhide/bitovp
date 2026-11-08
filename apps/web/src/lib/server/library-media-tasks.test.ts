import { randomUUID } from "node:crypto";
import { TRANSCRIPTION_POLICY_FINGERPRINT } from "@bitovp/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "./context";
import {
	cancelMediaTask,
	createMediaTask,
	readMediaTask,
	retryMediaTask,
} from "./library-media-tasks";

const holder = vi.hoisted(() => ({
	context: null as unknown as ServerContext,
}));
vi.mock("./context", () => ({ getServerContext: async () => holder.context }));
const org = randomUUID(),
	mediaId = randomUUID();
type Row = Record<string, unknown>;
let rows: Row[], media: Row;
const matches = (row: Row, where: Row): boolean =>
	Object.entries(where).every(([key, value]) => {
		if (key === "organizationId_requestKey")
			return !!value && typeof value === "object" && matches(row, value as Row);
		if (value && typeof value === "object") {
			const filter = value as Row;
			if (Array.isArray(filter.in)) return filter.in.includes(row[key]);
		}
		return row[key] === value;
	});
beforeEach(() => {
	rows = [];
	media = {
		id: mediaId,
		organizationId: org,
		sourceId: randomUUID(),
		state: "READY",
		sha256: "a".repeat(64),
		durationUs: 2_000_000n,
		timeMap: {
			id: mediaId,
			mediaVersionId: mediaId,
			kind: "CFR",
			sourceStartUs: 0,
			sourceEndUs: 2_000_000,
			editingStartFrame: 0,
			editingEndFrame: 60,
			fps: { num: 30, den: 1 },
		},
	};
	const task = {
		findUnique: vi.fn(
			async ({ where }: { where: Row }) =>
				rows.find((row) => matches(row, where)) ?? null,
		),
		findFirst: vi.fn(
			async ({ where }: { where: Row }) =>
				rows.find((row) => matches(row, where)) ?? null,
		),
		create: vi.fn(async ({ data }: { data: Row }) => {
			const row = {
				id: randomUUID(),
				state: "PENDING",
				phase: "QUEUED",
				progress: null,
				result: null,
				error: null,
				attempts: 0,
				analysisRevisionId: null,
				parentTaskId: null,
				createdAt: new Date(),
				finishedAt: null,
				...data,
			};
			rows.push(row);
			return row;
		}),
		updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
			let count = 0;
			for (const row of rows)
				if (matches(row, where)) {
					Object.assign(row, data);
					count++;
				}
			return { count };
		}),
	};
	let queue = Promise.resolve();
	const delegates = {
		libraryMediaTask: task,
		libraryMediaVersion: { findUnique: vi.fn(async () => media) },
		$executeRaw: vi.fn(async () => 1),
	};
	const prisma = {
		...delegates,
		$transaction: async <T>(fn: (tx: typeof delegates) => Promise<T>) => {
			const result = queue.then(() => fn(delegates));
			queue = result.then(
				() => undefined,
				() => undefined,
			);
			return result;
		},
	};
	holder.context = {
		prisma,
		tenant: { organizationId: org },
	} as unknown as ServerContext;
});
const input = (requestKey = randomUUID()) => ({
	kind: "TRANSCRIBE",
	mediaVersionId: mediaId,
	requestKey,
	parameters: { language: "ja" },
});
describe("media task intent and lifecycle boundary", () => {
	it("pins VAD/admission quality policy independently of ASR model bytes", async () => {
		await createMediaTask(input(), null);
		expect(
			(rows[0]?.parameters as { identity: unknown }).identity,
		).toMatchObject({
			transcriptionPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
		});
	});
	it("creates a durable task and replays a simultaneous request exactly once", async () => {
		const value = input();
		const [a, b] = await Promise.all([
			createMediaTask(value, "fixture"),
			createMediaTask(value, "fixture"),
		]);
		expect(a.taskId).toBe(b.taskId);
		expect(rows).toHaveLength(1);
		expect(await readMediaTask(a.taskId)).toMatchObject({
			taskId: a.taskId,
			state: "PENDING",
			kind: "TRANSCRIBE",
			cached: false,
		});
	});
	it("rejects a key reused with altered normalized parameters", async () => {
		const value = input();
		await createMediaTask(value, null);
		await expect(
			createMediaTask({ ...value, parameters: { language: "en" } }, null),
		).rejects.toMatchObject({ code: "REQUEST_KEY_REUSED" });
		expect(rows).toHaveLength(1);
	});
	it("does not accept paths or client proof", async () => {
		await expect(
			createMediaTask(
				{ ...input(), parameters: { language: "ja", sourcePath: "/private" } },
				null,
			),
		).rejects.toThrow();
		expect(rows).toHaveLength(0);
	});
	it("copies an exact same-organization success without creating another active job", async () => {
		const first = await createMediaTask(input(), null);
		const original = rows[0];
		if (!original) throw new Error("Missing fixture");
		Object.assign(original, {
			state: "SUCCEEDED",
			phase: "COMPLETE",
			result: { segments: [{ text: "こんにちは" }] },
			finishedAt: new Date(),
		});
		const second = await createMediaTask(input(), null);
		expect(second).toMatchObject({ state: "SUCCEEDED", cached: true });
		expect(second.taskId).not.toBe(first.taskId);
		expect((await readMediaTask(second.taskId)).result).toEqual(
			original.result,
		);
	});
	it("does not reuse a cache entry from a foreign organization", async () => {
		await createMediaTask(input(), null);
		const row = rows[0];
		if (!row) throw new Error("Missing fixture");
		Object.assign(row, {
			organizationId: randomUUID(),
			state: "SUCCEEDED",
			result: { private: true },
		});
		expect(await createMediaTask(input(), null)).toMatchObject({
			state: "PENDING",
			cached: false,
		});
	});
	it("queues incomplete preparation without pretending the key contains verified media bytes", async () => {
		Object.assign(media, {
			state: "PENDING",
			sha256: null,
			durationUs: null,
			timeMap: null,
		});
		const created = await createMediaTask(input(), null);
		const row = rows[0];
		expect(created.state).toBe("PENDING");
		expect(row?.phase).toBe("WAITING_FOR_MEDIA");
		expect(row?.parameters).toMatchObject({
			identity: { mediaSha256: null, timeMapHash: null },
		});
	});
	it("refuses foreign media even if an unscoped test delegate returns it", async () => {
		media.organizationId = randomUUID();
		await expect(createMediaTask(input(), null)).rejects.toMatchObject({
			code: "MEDIA_NOT_FOUND",
		});
		expect(rows).toHaveLength(0);
	});
	it("cancels a pending task while keeping success immutable", async () => {
		const created = await createMediaTask(input(), null);
		expect(await cancelMediaTask(created.taskId)).toMatchObject({
			state: "CANCELED",
		});
		const second = await createMediaTask(input(), null);
		const row = rows.find((entry) => entry.id === second.taskId);
		if (!row) throw new Error("Missing fixture");
		Object.assign(row, { state: "SUCCEEDED", result: { text: "retained" } });
		expect(await cancelMediaTask(second.taskId)).toMatchObject({
			state: "SUCCEEDED",
			result: { text: "retained" },
		});
	});
	it("retries as a fresh child intent and preserves the original canceled task", async () => {
		const first = await createMediaTask(input(), null);
		await cancelMediaTask(first.taskId);
		const key = randomUUID();
		const retry = await retryMediaTask(
			first.taskId,
			{ requestKey: key },
			"fixture",
		);
		expect(retry.taskId).not.toBe(first.taskId);
		expect(rows.find((row) => row.id === first.taskId)?.state).toBe("CANCELED");
		expect(await readMediaTask(retry.taskId)).toMatchObject({
			parentTaskId: first.taskId,
			state: "PENDING",
		});
		expect(
			await retryMediaTask(first.taskId, { requestKey: key }, "fixture"),
		).toEqual(retry);
	});
	it("does not reuse a partial success that explicitly disabled caching", async () => {
		await createMediaTask(input(), null);
		const row = rows[0];
		if (!row) throw new Error("Missing fixture");
		Object.assign(row, {
			state: "SUCCEEDED",
			result: { cacheable: false, warnings: ["ASR_MODEL_NOT_CONFIGURED"] },
		});
		expect(await createMediaTask(input(), null)).toMatchObject({
			state: "PENDING",
			cached: false,
		});
	});
});
