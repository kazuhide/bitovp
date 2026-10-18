import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: { storageInspection: { findUnique } },
	}),
}));

import { GET } from "./route";

const ID = "00000000-0000-4000-8000-0000000000f1";

const PROBE = {
	format: { format_name: "mov,mp4,m4a", duration: "10.000000" },
	streams: [{ index: 0, codec_type: "video", codec_name: "h264" }],
};

function get(id = ID) {
	return GET(new Request(`http://test/api/storage-inspections/${id}`), {
		params: Promise.resolve({ id }),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("GET /api/storage-inspections/[id]", () => {
	it("projects exactly the polling fields — nothing more", async () => {
		findUnique.mockResolvedValueOnce({
			id: ID,
			status: "FINISHED",
			bucket: "my-bucket",
			objectKey: "videos/raw/bbb.mp4",
			probe: PROBE,
			bytesRead: 8_388_608,
			error: null,
			createdAt: new Date("2026-08-06T00:00:00Z"),
			updatedAt: new Date("2026-08-06T00:00:05Z"),
		});
		const res = await get();
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(Object.keys(body).sort()).toEqual([
			"bucket",
			"bytesRead",
			"createdAt",
			"error",
			"id",
			"objectKey",
			"probe",
			"status",
			"updatedAt",
		]);
		expect(body.probe).toEqual(PROBE);
		expect(body.createdAt).toBe("2026-08-06T00:00:00.000Z");
	});

	it("selects an explicit column set (credentialId is not published)", async () => {
		findUnique.mockResolvedValueOnce(null);
		await get();
		const arg = findUnique.mock.calls[0]?.[0] as {
			select: Record<string, boolean>;
		};
		expect(arg.select).toBeDefined();
		expect(arg.select).not.toHaveProperty("credentialId");
		expect(Object.keys(arg.select).sort()).toEqual([
			"bucket",
			"bytesRead",
			"createdAt",
			"error",
			"id",
			"objectKey",
			"probe",
			"status",
			"updatedAt",
		]);
	});

	it("normalizes a still-pending row (probe null, bytesRead null)", async () => {
		findUnique.mockResolvedValueOnce({
			id: ID,
			status: "PENDING",
			bucket: "my-bucket",
			objectKey: "videos/raw/bbb.mp4",
			probe: null,
			bytesRead: null,
			error: null,
			createdAt: new Date("2026-08-06T00:00:00Z"),
			updatedAt: new Date("2026-08-06T00:00:00Z"),
		});
		const body = await (await get()).json();
		expect(body).toMatchObject({
			status: "PENDING",
			probe: null,
			bytesRead: null,
			error: null,
		});
	});

	it("404s an unknown id", async () => {
		findUnique.mockResolvedValueOnce(null);
		expect((await get()).status).toBe(404);
	});

	it("400s a non-uuid id without touching the DB", async () => {
		expect((await get("not-a-uuid")).status).toBe(400);
		expect(findUnique).not.toHaveBeenCalled();
	});
});
