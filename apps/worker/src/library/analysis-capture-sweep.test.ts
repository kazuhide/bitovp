import { matchesWhere, projectSelect } from "@bitovp/core/testing";
import type { AppPrismaClient } from "@bitovp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	inputs: vi.fn(),
	record: vi.fn(),
	reconcile: vi.fn(),
}));
vi.mock("@bitovp/db", async (original) => ({
	...(await original<typeof import("@bitovp/db")>()),
	listCapturedOriginalInputs: mocks.inputs,
}));
vi.mock("./captured-bindings", () => ({
	recordAuthoritativeAnalysisCapture: mocks.record,
	reconcileCapturedBindings: mocks.reconcile,
}));

import { createAnalysisSweep } from "./analysis-sweep";

const instant = new Date("2026-11-02T00:00:00Z");
const raw = { metadata: { version: "1.79.0" }, duration: 2, scenes: [] };
function setup(present = false) {
	const row: Record<string, unknown> = {
		id: "source",
		organizationId: "org",
		sourceKind: "VOD_JOB",
		encodingId: "encoding",
		accountId: "account",
		locales: ["en"],
		state: "PENDING",
		attempts: 0,
		availableAt: instant,
		leaseToken: null,
		leaseUntil: null,
		snapshot: {
			schemaVersion: 1,
			kind: "VOD_JOB",
			name: "asset",
			planHash: "hash",
			identity: "UNVERIFIED",
			inputs: [],
			playbackLinks: [],
			qcVerdict: null,
			qcOverriddenAt: null,
			analysisOutput: {
				credentialId: "00000000-0000-4000-8000-000000000001",
				bucket: "private",
				path: "out",
				filename: "aisa.json",
			},
		},
	};
	const updateMany = vi.fn(
		async ({
			where,
			data,
		}: {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		}) => {
			if (!matchesWhere(row, where)) return { count: 0 };
			for (const [key, value] of Object.entries(data))
				row[key] =
					key === "attempts"
						? Number(row.attempts) + (value as { increment: number }).increment
						: value;
			return { count: 1 };
		},
	);
	const db = {
		librarySource: {
			findMany: vi.fn(async ({ where, select }) =>
				matchesWhere(row, where) ? [projectSelect(row, select)] : [],
			),
			updateMany,
		},
		sceneAnalysisRevision: {
			findMany: vi.fn(async () => (present ? [{ locale: "en" }] : [])),
			upsert: vi.fn(),
		},
		$transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
	};
	const get = vi.fn(async () => raw);
	const getCaptured = vi.fn(async () => ({
		accountId: "account",
		encodingId: "encoding",
		locale: "en",
		providerResponseSha256: "a".repeat(64),
		raw,
	}));
	const readOutput = vi.fn(async () => raw);
	const tick = createAnalysisSweep({
		prisma: db as unknown as AppPrismaClient,
		captureBindings: true,
		providerFor: async () => ({ get, getCaptured }),
		readOutput,
		now: () => instant,
		uuid: () => "new-lease",
	});
	return { row, db, get, getCaptured, readOutput, tick };
}
beforeEach(() => {
	mocks.inputs.mockReset().mockResolvedValue([{ receiptId: "input" }]);
	mocks.record
		.mockReset()
		.mockResolvedValue({ analysisRevisionId: "analysis" });
	mocks.reconcile.mockReset().mockResolvedValue({ created: 0, preserved: 0 });
});
describe("future captured input analysis import integration", () => {
	it("uses the authoritative GET and atomic capture even when mutable stored JSON is available", async () => {
		const f = setup();
		await f.tick();
		expect(f.row.state).toBe("READY");
		expect(f.getCaptured).toHaveBeenCalledExactlyOnceWith("encoding", "en");
		expect(f.readOutput).not.toHaveBeenCalled();
		expect(f.get).not.toHaveBeenCalled();
		expect(f.db.sceneAnalysisRevision.upsert).not.toHaveBeenCalled();
		expect(mocks.record).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org",
				sourceId: "source",
				response: expect.objectContaining({ raw, locale: "en" }),
			}),
		);
		expect(mocks.reconcile).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ organizationId: "org", sourceId: "source" }),
		);
	});
	it("recovers a present locale without upgrading rawHash-only metadata", async () => {
		const f = setup(true);
		await f.tick();
		expect(f.getCaptured).toHaveBeenCalledOnce();
		expect(mocks.record).toHaveBeenCalledOnce();
		expect(f.row.state).toBe("READY");
	});
	it("keeps legacy imports unchanged and unverified when no future input receipt exists", async () => {
		mocks.inputs.mockResolvedValue([]);
		const f = setup();
		await f.tick();
		expect(f.readOutput).toHaveBeenCalledOnce();
		expect(f.getCaptured).not.toHaveBeenCalled();
		expect(mocks.record).not.toHaveBeenCalled();
		expect(mocks.reconcile).not.toHaveBeenCalled();
		expect(f.db.sceneAnalysisRevision.upsert).toHaveBeenCalledOnce();
		expect(f.row.state).toBe("READY");
	});
	it("cannot append evidence after a late response loses its source lease", async () => {
		const f = setup();
		f.getCaptured.mockImplementationOnce(async () => {
			f.row.leaseToken = "other-lease";
			return {
				accountId: "account",
				encodingId: "encoding",
				locale: "en",
				providerResponseSha256: "a".repeat(64),
				raw,
			};
		});
		await f.tick();
		expect(mocks.record).not.toHaveBeenCalled();
		expect(f.row.state).toBe("RUNNING");
		expect(f.row.leaseToken).toBe("other-lease");
	});
	it("leaves a visible retry instead of marking READY when atomic evidence persistence fails", async () => {
		mocks.record.mockRejectedValue(new Error("private provider data"));
		const f = setup();
		await f.tick();
		expect(f.row.state).toBe("ERROR");
		expect(f.row.error).not.toContain("private provider data");
		expect(f.readOutput).not.toHaveBeenCalled();
	});
});
