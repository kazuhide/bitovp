import { UnsupportedBrowseError } from "@bitovp/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listObjects = vi.fn();
const browserForCredentialId = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({}),
}));

vi.mock("@/lib/server/storage", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("@/lib/server/storage")>();
	return {
		...original,
		browserForCredentialId: (...args: unknown[]) =>
			browserForCredentialId(...args),
	};
});

import { GET } from "./route";

const ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const params = { params: Promise.resolve({ id: ID }) };

beforeEach(() => {
	vi.clearAllMocks();
	browserForCredentialId.mockResolvedValue({ listObjects });
});

function request(query: string): Request {
	return new Request(
		`http://test/api/credentials/${ID}/storage/objects${query}`,
	);
}

describe("GET …/storage/objects", () => {
	it("requires a bucket", async () => {
		const res = await GET(request(""), params);
		expect(res.status).toBe(400);
	});

	it("passes bucket/prefix/cursor through and returns the listing", async () => {
		listObjects.mockResolvedValueOnce({
			prefixes: ["videos/raw/"],
			objects: [{ key: "videos/a.mp4", size: 1 }],
			nextCursor: "t2",
		});
		const res = await GET(
			request("?bucket=media&prefix=videos%2F&cursor=t1&limit=50"),
			params,
		);
		expect(res.status).toBe(200);
		expect(listObjects).toHaveBeenCalledWith({
			bucket: "media",
			prefix: "videos/",
			cursor: "t1",
			limit: 50,
		});
		expect(await res.json()).toMatchObject({ nextCursor: "t2" });
	});

	it("maps unsupported providers to 400 without exposing driver prose", async () => {
		listObjects.mockRejectedValueOnce(
			new UnsupportedBrowseError("Role-based credentials need an STS broker"),
		);
		const res = await GET(request("?bucket=media"), params);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			error: "Storage browsing is not supported for this credential",
			details: { code: "STORAGE_BROWSE_UNSUPPORTED" },
		});
	});

	it("maps upstream failures to 502 with code+status only", async () => {
		listObjects.mockRejectedValueOnce(
			Object.assign(new Error("secret endpoint detail leaked"), {
				name: "AccessDenied",
				$metadata: { httpStatusCode: 403 },
			}),
		);
		const res = await GET(request("?bucket=media"), params);
		expect(res.status).toBe(502);
		const body = await res.json();
		expect(body.error).toBe(
			"Storage request failed: AccessDenied (upstream 403)",
		);
		expect(JSON.stringify(body)).not.toContain("secret endpoint detail");
	});

	it("maps an Azure RestError to its service code, not the class name", async () => {
		listObjects.mockRejectedValueOnce(
			Object.assign(new Error("Server failed to authenticate the request"), {
				name: "RestError",
				code: "AuthenticationFailed",
				statusCode: 403,
			}),
		);
		const res = await GET(request("?bucket=media"), params);
		expect(res.status).toBe(502);
		expect((await res.json()).error).toBe(
			"Storage request failed: AuthenticationFailed (upstream 403)",
		);
	});

	it("404s for unknown credentials", async () => {
		browserForCredentialId.mockResolvedValueOnce(null);
		const res = await GET(request("?bucket=media"), params);
		expect(res.status).toBe(404);
	});

	describe("server-side search", () => {
		/** One page per call, cursored so the walk keeps going. */
		function pages(...results: unknown[]) {
			for (const result of results) {
				listObjects.mockResolvedValueOnce(result);
			}
		}

		it("walks recursively and returns matches with the scan report", async () => {
			pages(
				{
					prefixes: ["in/a/"],
					objects: [{ key: "in/a/trailer.mp4", size: 1 }],
					nextCursor: "c1",
				},
				{ prefixes: [], objects: [{ key: "in/b/other.mov", size: 2 }] },
			);
			const res = await GET(
				request("?bucket=media&prefix=in%2F&search=TRAILER"),
				params,
			);
			expect(res.status).toBe(200);
			// Recursive on every page — a delimited listing would never reach
			// objects nested below the browsed folder.
			expect(listObjects).toHaveBeenNthCalledWith(1, {
				bucket: "media",
				prefix: "in/",
				cursor: undefined,
				limit: undefined,
				recursive: true,
			});
			expect(listObjects).toHaveBeenNthCalledWith(
				2,
				expect.objectContaining({ cursor: "c1", recursive: true }),
			);
			const body = await res.json();
			expect(body.objects.map((o: { key: string }) => o.key)).toEqual([
				"in/a/trailer.mp4",
			]);
			// Folder rows are meaningless in a recursive answer.
			expect(body.prefixes).toEqual([]);
			expect(body.scan).toMatchObject({
				scannedObjects: 2,
				scannedPages: 2,
				complete: true,
			});
		});

		it("bounds the scan and says so instead of implying an empty bucket", async () => {
			listObjects.mockResolvedValue({
				prefixes: [],
				objects: [{ key: "in/nope.mov", size: 1 }],
				nextCursor: "next",
			});
			const res = await GET(request("?bucket=media&search=trailer"), params);
			const body = await res.json();
			expect(body.objects).toEqual([]);
			expect(body.scan).toMatchObject({
				scanLimitReached: true,
				complete: false,
			});
			// The truncation is resumable, not a dead end.
			expect(body.nextCursor).toBe("next");
			expect(listObjects.mock.calls.length).toBeLessThanOrEqual(25);
		});

		it("searches by extension alone", async () => {
			pages({
				prefixes: [],
				objects: [
					{ key: "in/a.mp4", size: 1 },
					{ key: "in/b.mov", size: 2 },
				],
			});
			const res = await GET(request("?bucket=media&ext=mp4"), params);
			const body = await res.json();
			expect(body.objects.map((o: { key: string }) => o.key)).toEqual([
				"in/a.mp4",
			]);
		});

		it("treats an empty search param as a plain listing", async () => {
			listObjects.mockResolvedValueOnce({ prefixes: [], objects: [] });
			const res = await GET(request("?bucket=media&search=&ext="), params);
			expect(res.status).toBe(200);
			expect(listObjects).toHaveBeenCalledWith({
				bucket: "media",
				prefix: undefined,
				cursor: undefined,
				limit: undefined,
			});
		});

		it("keeps the per-page limit at 100 (C6)", async () => {
			const res = await GET(
				request("?bucket=media&search=a&limit=500"),
				params,
			);
			expect(res.status).toBe(400);
		});
	});
});
