import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyPath } from "@/lib/auth/gate";
import { evaluateRole } from "@/lib/auth/roles";

const findUnique = vi.fn();
const resolvePreview = vi.fn();
const servePreview = vi.fn();
let enabled = true;
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			appSetting: { findUnique: async () => ({ value: { qcVmaf: enabled } }) },
			vmafJob: { findUnique },
		},
	}),
}));
vi.mock("@/lib/server/vmaf-preview", () => ({
	resolveVmafPreview: (...args: unknown[]) => resolvePreview(...args),
	serveVmafPreview: (...args: unknown[]) => servePreview(...args),
}));

import { GET } from "./route";

const id = "00000000-0000-4000-8000-000000000001";
const resultId = "00000000-0000-4000-8000-000000000002";
const path = `/api/vmaf-jobs/${id}/preview`;
const call = (query = `resultId=${resultId}`, jobId = id) =>
	GET(new Request(`http://test${path}?${query}`), {
		params: Promise.resolve({ id: jobId }),
	});
beforeEach(() => {
	vi.clearAllMocks();
	enabled = true;
});
describe("GET report-scoped QC media (small, mocked DB/storage)", () => {
	it("is covered by existing protected API and viewer-read role policy", () => {
		expect(classifyPath(path)).toBe("api-guarded");
		expect(evaluateRole("VIEWER", path, "GET")).toMatchObject({
			allowed: true,
		});
	});
	it("feature-off returns 404 without reading the report", async () => {
		enabled = false;
		expect((await call()).status).toBe(404);
		expect(findUnique).not.toHaveBeenCalled();
	});
	it.each([
		"",
		"resultId=nope",
		`resultId=${resultId}&url=https://evil.example/a`,
		`resultId=${resultId}&resultId=${resultId}`,
	])("rejects invalid or extra query %s", async (query) => {
		expect((await call(query)).status).toBe(400);
		expect(findUnique).not.toHaveBeenCalled();
	});
	it("rejects non-UUID report ids", async () => {
		expect((await call(`resultId=${resultId}`, "nope")).status).toBe(400);
		expect(findUnique).not.toHaveBeenCalled();
	});
	it.each([
		null,
		{ results: [] },
	])("404s an absent report or a result from another report", async (row) => {
		findUnique.mockResolvedValue(row);
		expect((await call()).status).toBe(404);
		expect(servePreview).not.toHaveBeenCalled();
	});
	it("selects only the requested result under this report; returns bytes without provenance", async () => {
		const row = {
			mode: "VOD",
			params: {},
			encodingJob: { plan: {} },
			results: [
				{ id: resultId, provenance: { private: true }, renditionRef: {} },
			],
		};
		findUnique.mockResolvedValue(row);
		resolvePreview.mockReturnValue({ key: "private" });
		servePreview.mockResolvedValue(new Response("media", { status: 206 }));
		const response = await call();
		expect(response.status).toBe(206);
		expect(await response.text()).toBe("media");
		expect(findUnique.mock.calls[0]?.[0]).toMatchObject({
			where: { id },
			select: { results: { where: { id: resultId } } },
		});
		expect(resolvePreview).toHaveBeenCalledWith(row, row.results[0]);
	});
	it("unavailable measurements never create a storage browser", async () => {
		findUnique.mockResolvedValue({ results: [{ id: resultId }] });
		resolvePreview.mockReturnValue({ unavailableReason: "MISSING_PROVENANCE" });
		const response = await call();
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			details: { code: "MISSING_PROVENANCE" },
		});
		expect(servePreview).not.toHaveBeenCalled();
	});
});

it("retains result scoping and Range headers for an organization-bound native preview", async () => {
	const row = {
		mode: "VOD",
		params: {},
		encodingJob: null,
		results: [{ id: resultId, renditionRef: {}, provenance: null }],
	};
	findUnique.mockResolvedValue(row);
	resolvePreview.mockReturnValue({
		credentialId: id,
		bucket: "private",
		key: "measured/video.mp4",
	});
	servePreview.mockResolvedValue(new Response(null, { status: 206 }));
	const req = new Request(
		`http://localhost${path}?resultId=${resultId}&expectedOrganizationId=${id}`,
		{ headers: { Range: "bytes=0-15" } },
	);
	expect((await GET(req, { params: Promise.resolve({ id }) })).status).toBe(
		206,
	);
	expect(findUnique).toHaveBeenCalledWith(
		expect.objectContaining({ where: { id } }),
	);
	expect(servePreview.mock.calls[0]?.[1]).toBe(req);
	expect(servePreview.mock.calls[0]?.[1].headers.get("Range")).toBe(
		"bytes=0-15",
	);
});
it.each([
	`expectedOrganizationId=invalid`,
	`expectedOrganizationId=${id}&expectedOrganizationId=${id}`,
])("rejects malformed preview organization markers before reading results: %s", async (query) => {
	expect((await call(`resultId=${resultId}&${query}`)).status).toBe(400);
	expect(findUnique).not.toHaveBeenCalled();
});
