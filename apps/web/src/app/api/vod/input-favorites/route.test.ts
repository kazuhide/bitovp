import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContextError } from "@/lib/auth/tenancy";
import { VodInputFavoriteError } from "@/lib/server/vod-input-favorites";
import { DELETE } from "./[id]/route";
import { GET, POST } from "./route";

const mock = vi.hoisted(() => ({
	list: vi.fn(),
	add: vi.fn(),
	remove: vi.fn(),
}));
vi.mock("@/lib/server/vod-input-favorites", async (original) => ({
	...(await original<object>()),
	listVodInputFavorites: mock.list,
	addVodInputFavorite: mock.add,
	deleteVodInputFavorite: mock.remove,
}));
const id = "00000000-0000-4000-8000-000000000001";
const source = {
	credentialId: id,
	bucket: "input",
	objectKey: "logo.png",
	label: "Logo",
	kind: "IMAGE",
};
beforeEach(() => {
	vi.clearAllMocks();
	mock.list.mockResolvedValue({ favorites: [] });
	mock.add.mockResolvedValue({ ...source, id });
	mock.remove.mockResolvedValue(undefined);
});
const request = (body: unknown) =>
	new Request("http://localhost/api/vod/input-favorites", {
		method: "POST",
		body: JSON.stringify(body),
	});

describe("VOD fixed source routes", () => {
	it("returns an organization-private list", async () => {
		const response = await GET();
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(await response.json()).toEqual({ favorites: [] });
	});
	it("creates an opaque image reference", async () => {
		const response = await POST(request(source));
		expect(response.status).toBe(201);
		expect(mock.add).toHaveBeenCalledWith(source);
		expect(await response.json()).toEqual({ favorite: { ...source, id } });
	});
	it("refuses malformed, secret-bearing and oversized bodies before persistence", async () => {
		for (const value of [null, { ...source, signedUrl: "secret" }])
			expect((await POST(request(value))).status).toBe(400);
		expect(
			(await POST(request({ ...source, label: "x".repeat(20_000) }))).status,
		).toBe(413);
		expect(mock.add).not.toHaveBeenCalled();
	});
	it("deletes idempotently without exposing media deletion", async () => {
		const response = await DELETE(new Request("http://localhost"), {
			params: Promise.resolve({ id }),
		});
		expect(response.status).toBe(204);
		expect(mock.remove).toHaveBeenCalledWith(id);
		expect(
			(
				await DELETE(new Request("http://localhost"), {
					params: Promise.resolve({ id: "../foreign" }),
				})
			).status,
		).toBe(400);
		expect(mock.remove).toHaveBeenCalledTimes(1);
	});
	it("keeps authorization and data corruption errors distinct from an empty registry", async () => {
		mock.list.mockRejectedValueOnce(
			new AuthContextError(403, "Operator required"),
		);
		expect((await GET()).status).toBe(403);
		mock.list.mockRejectedValueOnce(
			new VodInputFavoriteError(409, "FAVORITES_INVALID"),
		);
		const response = await GET();
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			details: { code: "FAVORITES_INVALID" },
		});
	});
});
