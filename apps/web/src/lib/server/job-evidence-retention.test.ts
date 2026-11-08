import type { AppPrismaClient } from "@bitovp/db";
import { beforeEach, expect, it, vi } from "vitest";
import { RESET_CATALOG } from "@/lib/reset-selection";
import type { ServerContext } from "./context";
import { deleteEncodingJobLocally } from "./delete-jobs";
import { countResetCategories } from "./selected-reset";

const audit = vi.hoisted(() => vi.fn());
vi.mock("./audit", () => ({ writeAuditLog: audit }));
const jobId = "10000000-0000-4000-8000-000000000001";
const req = new Request(`https://local.test/api/encoding-jobs/${jobId}`, {
	method: "DELETE",
});

function fixture(
	input: {
		before?: number;
		inside?: number;
		after?: number;
		failure?: unknown;
	} = {},
) {
	const writes: string[] = [];
	const receipts = vi
		.fn()
		.mockResolvedValueOnce(input.before ?? 0)
		.mockResolvedValue(input.after ?? 0);
	const insideReceipts = vi.fn(async () => input.inside ?? input.before ?? 0);
	const tx = {
		$queryRaw: vi.fn(async () => []),
		libraryEvidenceReceipt: { count: insideReceipts },
		librarySource: { findUnique: vi.fn(async () => null) },
		encodingJob: {
			findMany: vi.fn(async () => []),
			deleteMany: vi.fn(async () => {
				writes.push("job");
				return { count: 1 };
			}),
		},
		vmafJob: {
			count: vi.fn(async () => 0),
			deleteMany: vi.fn(async () => {
				writes.push("vmaf");
				return { count: 1 };
			}),
		},
	};
	const prisma = {
		libraryEvidenceReceipt: { count: receipts },
		encodingJob: {
			findUnique: vi.fn(async () => ({
				id: jobId,
				status: "FINISHED",
				bitmovinAccountId: null,
			})),
		},
		vmafJob: { findFirst: vi.fn(async () => null) },
		$transaction: vi.fn(async (run: (t: typeof tx) => Promise<unknown>) => {
			if (input.failure) throw input.failure;
			return run(tx);
		}),
	};
	return { ctx: { prisma } as unknown as ServerContext, prisma, tx, writes };
}

beforeEach(() => audit.mockReset());

it("refuses retained job evidence before deleting any dependent or starting a transaction", async () => {
	const f = fixture({ before: 2 });
	expect(await deleteEncodingJobLocally(f.ctx, jobId, { req })).toMatchObject({
		ok: false,
		code: "JOB_LIBRARY_EVIDENCE_REFERENCES",
		protectedCount: 2,
	});
	expect(f.prisma.libraryEvidenceReceipt.count).toHaveBeenCalledWith({
		where: { jobId },
	});
	expect(f.prisma.$transaction).not.toHaveBeenCalled();
	expect(f.writes).toEqual([]);
	expect(audit).not.toHaveBeenCalled();
});

it("rechecks receipts after acquiring the job lock when capture lands after preflight", async () => {
	const f = fixture({ before: 0, inside: 1 });
	expect(await deleteEncodingJobLocally(f.ctx, jobId, { req })).toMatchObject({
		ok: false,
		code: "JOB_LIBRARY_EVIDENCE_REFERENCES",
		protectedCount: 1,
	});
	expect(f.tx.$queryRaw).toHaveBeenCalled();
	expect(f.tx.libraryEvidenceReceipt.count).toHaveBeenCalledWith({
		where: { jobId },
	});
	expect(f.writes).toEqual([]);
	expect(audit).not.toHaveBeenCalled();
});

it("maps a raced receipt foreign key after transaction rollback to the same retention outcome", async () => {
	const f = fixture({
		before: 0,
		after: 1,
		failure: {
			code: "P2003",
			meta: { field_name: "LibraryEvidenceReceipt_jobId_tenant_fkey" },
		},
	});
	expect(await deleteEncodingJobLocally(f.ctx, jobId, { req })).toMatchObject({
		ok: false,
		code: "JOB_LIBRARY_EVIDENCE_REFERENCES",
		protectedCount: 1,
	});
	expect(f.writes).toEqual([]);
	expect(audit).not.toHaveBeenCalled();
});

it("does not relabel an unrelated foreign key failure when no job evidence exists", async () => {
	const failure = { code: "P2003", meta: { field_name: "unrelated_fkey" } };
	const f = fixture({ failure });
	await expect(deleteEncodingJobLocally(f.ctx, jobId, { req })).rejects.toBe(
		failure,
	);
});

it("reports job-evidence retention in the vodJobs preview without calling those jobs deletable", async () => {
	const tables = Object.fromEntries(
		RESET_CATALOG.flatMap((entry) => [...entry.models]).map((name) => [
			name,
			{
				count: vi.fn(async (args?: { where?: { jobId?: unknown } }) =>
					name === "libraryEvidenceReceipt" && args?.where?.jobId
						? 2
						: name === "encodingJob"
							? 3
							: 0,
				),
			},
		]),
	);
	const view = await countResetCategories(tables as unknown as AppPrismaClient);
	expect(view.find((row) => row.category === "vodJobs")).toEqual({
		category: "vodJobs",
		count: 3,
		protectedCount: 2,
	});
});
