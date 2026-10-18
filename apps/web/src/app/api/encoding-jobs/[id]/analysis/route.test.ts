import { LibrarySourceError } from "@bitovp/db";
import { beforeEach, expect, it, vi } from "vitest";

const capture = vi.fn();
const prisma = {
	encodingJob: { findUnique: vi.fn() },
	librarySource: { findFirst: vi.fn() },
};
const audit = vi.fn();
vi.mock("@bitovp/db", async (original) => ({
	...(await original<Record<string, unknown>>()),
	requestLibrarySource: (...args: unknown[]) => capture(...args),
}));
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({ prisma }),
}));
vi.mock("@/lib/server/audit", () => ({
	writeAuditLog: (...args: unknown[]) => audit(...args),
}));

import { GET, POST } from "./route";

const id = "00000000-0000-4000-8000-000000000001";
const request = () =>
	new Request(`http://test/api/encoding-jobs/${id}/analysis`, {
		method: "POST",
	});

beforeEach(() => vi.clearAllMocks());

it("returns only the analysis view and durable capture suppression", async () => {
	prisma.encodingJob.findUnique.mockResolvedValue({
		plan: {},
		bitmovinEncodingId: "encoding",
		libraryCaptureSuppressed: true,
		privateData: "never-return",
	});
	prisma.librarySource.findFirst.mockResolvedValue(null);
	const response = await GET(request(), { params: Promise.resolve({ id }) });
	expect(await response.json()).toEqual({
		enabled: false,
		captureSuppressed: true,
		source: null,
	});
	expect(prisma.encodingJob.findUnique).toHaveBeenCalledWith({
		where: { id },
		select: {
			plan: true,
			bitmovinEncodingId: true,
			libraryCaptureSuppressed: true,
		},
	});
});

it("treats a user capture request as explicit so a reset library can be registered again", async () => {
	capture.mockResolvedValue({ id: "source" });
	const response = await POST(request(), { params: Promise.resolve({ id }) });
	expect(response.status).toBe(202);
	expect(await response.json()).toEqual({ sourceId: "source" });
	expect(capture).toHaveBeenCalledWith(prisma, id, { explicit: true });
	expect(audit).toHaveBeenCalledOnce();
});

it("retains capture eligibility errors without an audit success", async () => {
	capture.mockRejectedValue(
		new LibrarySourceError(409, "Only finished jobs can be captured"),
	);
	const response = await POST(request(), { params: Promise.resolve({ id }) });
	expect(response.status).toBe(409);
	expect(audit).not.toHaveBeenCalled();
});
