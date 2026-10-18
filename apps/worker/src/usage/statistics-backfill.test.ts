import type { AppPrismaClient } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import { createUsageBackfillProcessor } from "./statistics-backfill";

const payload = {
	accountId: "11111111-1111-4111-8111-111111111111",
	from: "2024-01-01",
	to: "2024-01-26",
	generation: "22222222-2222-4222-8222-222222222222",
};
function fixture() {
	const upsert = vi.fn().mockResolvedValue({});
	const cursor = vi.fn().mockResolvedValue({});
	const updateCursor = vi.fn().mockResolvedValue({ count: 1 });
	const listDaily = vi.fn().mockResolvedValue([]);
	const providerFor = vi.fn().mockResolvedValue({ listDaily });
	const marker = { value: payload.generation };
	const queryRaw = vi.fn(async (sql: TemplateStringsArray) =>
		sql.join("").includes("BitmovinAccount")
			? [{ id: payload.accountId }]
			: [marker],
	);
	const transaction = vi.fn(async (fn) =>
		fn({
			$queryRaw: queryRaw,
			usageDailyStatistic: { upsert },
			usageSweepCursor: { upsert: cursor, updateMany: updateCursor },
		}),
	);
	const prisma = {
		$transaction: transaction,
		bitmovinAccount: {
			findUnique: vi.fn().mockResolvedValue({ id: payload.accountId }),
		},
		usageDailyStatistic: { upsert },
		usageSweepCursor: { upsert: cursor },
	} as unknown as AppPrismaClient;
	const job = {
		data: payload as unknown,
		progress: 0 as unknown,
		updateProgress: vi.fn(async (progress: unknown) => {
			job.progress = progress;
		}),
	};
	return {
		upsert,
		cursor,
		listDaily,
		providerFor,
		prisma,
		job,
		marker,
		updateCursor,
	};
}

describe("statistics history import", () => {
	it("imports old account-wide windows including quiet days without moving the routine cursor", async () => {
		const f = fixture();
		await createUsageBackfillProcessor(f)(f.job);
		expect(f.providerFor).toHaveBeenCalledExactlyOnceWith(payload.accountId);
		expect(f.listDaily.mock.calls).toEqual([
			["VOD", "2024-01-01", "2024-01-25"],
			["VOD", "2024-01-26", "2024-01-26"],
			["LIVE", "2024-01-01", "2024-01-25"],
			["LIVE", "2024-01-26", "2024-01-26"],
		]);
		expect(f.upsert).toHaveBeenCalledTimes(52);
		expect(f.cursor).not.toHaveBeenCalled();
		expect(f.job.progress).toMatchObject({
			completedChunks: 4,
			totalChunks: 4,
			rowsUpserted: 52,
		});
	});

	it("resumes only committed chunks after a provider error and preserves partial progress", async () => {
		const f = fixture();
		f.listDaily
			.mockResolvedValueOnce([])
			.mockRejectedValueOnce({ httpStatusCode: 429 });
		const run = createUsageBackfillProcessor(f);
		await expect(run(f.job)).rejects.toThrow("Statistics import failed");
		expect(f.job.progress).toMatchObject({
			completedChunks: 1,
			rowsUpserted: 25,
		});
		f.listDaily.mockClear();
		await run(f.job);
		expect(f.listDaily.mock.calls[0]).toEqual([
			"VOD",
			"2024-01-26",
			"2024-01-26",
		]);
		expect(f.job.progress).toMatchObject({
			completedChunks: 4,
			rowsUpserted: 52,
		});
	});

	it.each([
		{ rows: [{ date: "2024-01-01" }, { date: "2024-01-01" }] },
		{ rows: [{ date: "2023-12-31" }] },
		{ rows: [{}] },
	])("rejects an invalid provider window before any snapshot or progress update", async ({
		rows,
	}) => {
		const f = fixture();
		f.listDaily.mockResolvedValue(rows);
		await expect(createUsageBackfillProcessor(f)(f.job)).rejects.toThrow(
			"Statistics import failed",
		);
		expect(f.upsert).not.toHaveBeenCalled();
		expect(f.job.progress).toMatchObject({ completedChunks: 0 });
	});

	it("rejects invalid/future payloads before credentials or provider reads", async () => {
		const f = fixture();
		f.job.data = { ...payload, to: "9999-01-01" };
		await expect(createUsageBackfillProcessor(f)(f.job)).rejects.toThrow();
		expect(f.providerFor).not.toHaveBeenCalled();
	});

	it("does not advance progress when a snapshot write fails", async () => {
		const f = fixture();
		f.upsert.mockRejectedValueOnce(new Error("db down"));
		await expect(createUsageBackfillProcessor(f)(f.job)).rejects.toThrow(
			"Statistics import failed",
		);
		expect(f.job.progress).toMatchObject({ completedChunks: 0 });
	});

	it("does not recreate snapshots when reset removes ownership during a provider read", async () => {
		const f = fixture();
		f.listDaily.mockImplementationOnce(async () => {
			f.marker.value = "reset";
			return [];
		});
		await expect(createUsageBackfillProcessor(f)(f.job)).rejects.toThrow(
			"Statistics import failed",
		);
		expect(f.upsert).not.toHaveBeenCalled();
	});

	it.each([
		{
			completedChunks: 4,
			totalChunks: 4,
			rowsUpserted: 52,
			through: { VOD: "2025-01-01" },
		},
		{
			completedChunks: 1,
			totalChunks: 4,
			rowsUpserted: 25,
			through: { VOD: "2024-01-05" },
		},
		{ completedChunks: 4, totalChunks: 4, rowsUpserted: 52, through: {} },
	])("rejects inconsistent checkpoints without skipping history", async (progress) => {
		const f = fixture();
		f.job.progress = progress;
		await expect(createUsageBackfillProcessor(f)(f.job)).rejects.toThrow(
			"Invalid statistics import checkpoint",
		);
		expect(f.providerFor).not.toHaveBeenCalled();
	});
});

it("advances automatic cursors only inside validated owned chunk transactions", async () => {
	const f = fixture();
	f.job.data = { ...payload, automatic: true };
	await createUsageBackfillProcessor(f)(f.job);
	expect(f.cursor).toHaveBeenCalledTimes(4);
	expect(f.updateCursor).toHaveBeenLastCalledWith(
		expect.objectContaining({
			where: expect.objectContaining({
				bitmovinAccountId: payload.accountId,
				kind: "LIVE",
				sweptThrough: { lte: new Date("2024-01-26") },
			}),
			data: expect.objectContaining({ sweptThrough: new Date("2024-01-26") }),
		}),
	);
});
it("does not advance an automatic cursor when its chunk fails to store or loses ownership", async () => {
	for (const reset of [false, true]) {
		const f = fixture();
		f.job.data = { ...payload, automatic: true };
		if (reset)
			f.listDaily.mockImplementationOnce(async () => {
				f.marker.value = "reset";
				return [];
			});
		else f.upsert.mockRejectedValueOnce(new Error("db down"));
		await expect(createUsageBackfillProcessor(f)(f.job)).rejects.toThrow();
		expect(f.cursor).not.toHaveBeenCalled();
	}
});
