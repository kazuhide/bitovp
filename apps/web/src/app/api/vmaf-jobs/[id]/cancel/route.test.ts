import { NextResponse } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";
import { evaluateRole } from "@/lib/auth/roles";

const mocks = vi.hoisted(() => ({
	findUnique: vi.fn(),
	updateMany: vi.fn(),
	gate: vi.fn(),
}));
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({ prisma: { vmafJob: mocks } }),
}));
vi.mock("@/lib/server/feature-flags", () => ({
	requireQcVmafEnabled: mocks.gate,
}));

import { POST } from "./route";

const id = "00000000-0000-4000-8000-000000000001";
const cloud = { backend: "CLOUD", profileId: "aws-test", budgetUsd: 10 };
function request(value = id) {
	return POST(
		new Request(`http://test/api/vmaf-jobs/${value}/cancel`, {
			method: "POST",
		}),
		{ params: Promise.resolve({ id: value }) },
	);
}
beforeEach(() => {
	vi.resetAllMocks();
	mocks.gate.mockResolvedValue(null);
	mocks.updateMany.mockResolvedValue({ count: 1 });
});
it.each([
	"PENDING",
	"RUNNING",
])("atomically cancels active cloud %s while retaining its row", async (status) => {
	mocks.findUnique.mockResolvedValue({
		mode: "VOD",
		status,
		params: { execution: cloud },
	});
	expect((await request()).status).toBe(200);
	expect(mocks.updateMany).toHaveBeenCalledWith({
		where: {
			id,
			mode: "VOD",
			status: { in: ["PENDING", "RUNNING"] },
			params: { path: ["execution", "backend"], equals: "CLOUD" },
		},
		data: {
			status: "ERROR",
			error: "Cloud measurement canceled; cleanup continues",
		},
	});
});
it.each([
	"FINISHED",
	"ERROR",
])("is idempotent for terminal cloud %s", async (status) => {
	mocks.findUnique.mockResolvedValue({
		mode: "VOD",
		status,
		params: { execution: cloud },
	});
	expect((await request()).status).toBe(200);
	expect(mocks.updateMany).not.toHaveBeenCalled();
});
it("does not overwrite a completion that races cancellation", async () => {
	mocks.findUnique.mockResolvedValue({
		mode: "VOD",
		status: "RUNNING",
		params: { execution: cloud },
	});
	mocks.updateMany.mockResolvedValue({ count: 0 });
	expect((await request()).status).toBe(200);
	expect(mocks.updateMany).toHaveBeenCalledTimes(1);
});
it.each([
	{ mode: "VOD", params: {} },
	{ mode: "VOD", params: { execution: { backend: "LOCAL" } } },
	{ mode: "LIVE", params: { execution: cloud } },
])("rejects unsupported jobs", async (job) => {
	mocks.findUnique.mockResolvedValue({ ...job, status: "RUNNING" });
	expect((await request()).status).toBe(409);
	expect(mocks.updateMany).not.toHaveBeenCalled();
});
it("returns 404 for unknown jobs", async () => {
	mocks.findUnique.mockResolvedValue(null);
	expect((await request()).status).toBe(404);
});
it("validates the ID before reading", async () => {
	expect((await request("bad")).status).toBe(400);
	expect(mocks.findUnique).not.toHaveBeenCalled();
});
it("honors the QC flag", async () => {
	mocks.gate.mockResolvedValue(NextResponse.json({}, { status: 404 }));
	expect((await request()).status).toBe(404);
	expect(mocks.findUnique).not.toHaveBeenCalled();
});
it("requires OPERATOR for the shared auth gate", () => {
	expect(
		evaluateRole("VIEWER", `/api/vmaf-jobs/${id}/cancel`, "POST").allowed,
	).toBe(false);
	expect(
		evaluateRole("OPERATOR", `/api/vmaf-jobs/${id}/cancel`, "POST").allowed,
	).toBe(true);
});
