import { Readable } from "node:stream";
import { beforeEach, expect, it, vi } from "vitest";
import type { ServerContext } from "./context";
import { serveImageAsset } from "./library-image-assets";

const fixture = vi.hoisted(() => ({
	context: {} as ServerContext,
	browser: vi.fn(),
}));
vi.mock("./context", () => ({ getServerContext: async () => fixture.context }));
vi.mock("./storage", () => ({ browserForCredentialId: fixture.browser }));
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	org = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
	bytes = Buffer.from("verified-png-bytes");
let read: ReturnType<typeof vi.fn>;
beforeEach(() => {
	read = vi.fn().mockResolvedValue({
		id,
		storage: {
			credentialId: id,
			bucket: "fixture",
			key: "image.png",
			size: bytes.length,
			expect: { etag: "fixed-image" },
		},
		size: BigInt(bytes.length),
	});
	fixture.context = {
		tenant: { organizationId: org },
		prisma: { libraryImageAsset: { findUnique: read } },
	} as unknown as ServerContext;
	fixture.browser.mockReset();
	fixture.browser.mockResolvedValue({
		getObject: async ({ range }: { range: { start: number; end: number } }) =>
			Readable.from([bytes.subarray(range.start, range.end + 1)]),
		dispose: vi.fn(),
	});
});
it.each([
	"GET",
	"HEAD",
])("serves a pinned uploaded image with %s through the real download validator", async (method) => {
	const response = await serveImageAsset(
		new Request(
			`http://localhost/api/library/image-assets/${id}/media?expectedOrganizationId=${org}`,
			{ method },
		),
		id,
	);
	expect(response.status).toBe(200);
	expect(response.headers.get("Content-Type")).toBe("image/png");
	expect(response.headers.get("Content-Disposition")).toBe("inline");
	if (method === "GET")
		expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
	else expect(response.body).toBeNull();
});
it("refuses a duplicate organization assertion before accessing an image or storage", async () => {
	await expect(
		serveImageAsset(
			new Request(
				`http://localhost/api/library/image-assets/${id}/media?expectedOrganizationId=${org}&expectedOrganizationId=${org}`,
			),
			id,
		),
	).rejects.toMatchObject({ code: "MEDIA_ORGANIZATION_CHANGED" });
	expect(read).not.toHaveBeenCalled();
	expect(fixture.browser).not.toHaveBeenCalled();
});
