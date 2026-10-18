import { UnsupportedBrowseError } from "@bitovp/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listBuckets = vi.fn();
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
const req = () => new Request("http://test");

beforeEach(() => {
	vi.clearAllMocks();
});

describe("GET …/storage/buckets", () => {
	it("returns bucket names and disposes the driver", async () => {
		const dispose = vi.fn();
		browserForCredentialId.mockResolvedValueOnce({ listBuckets, dispose });
		listBuckets.mockResolvedValueOnce(["alpha"]);
		const res = await GET(req(), params);
		expect(await res.json()).toEqual({ buckets: ["alpha"] });
		expect(dispose).toHaveBeenCalled();
	});

	it("maps driver-creation refusal (e.g. Azure) to 400", async () => {
		browserForCredentialId.mockRejectedValueOnce(
			new UnsupportedBrowseError("Azure Blob browsing lands in P2"),
		);
		const res = await GET(req(), params);
		expect(res.status).toBe(400);
	});

	it("404s for unknown credentials", async () => {
		browserForCredentialId.mockResolvedValueOnce(null);
		const res = await GET(req(), params);
		expect(res.status).toBe(404);
	});

	it("rejects non-uuid ids", async () => {
		const res = await GET(req(), {
			params: Promise.resolve({ id: "../etc" }),
		});
		expect(res.status).toBe(400);
		expect(browserForCredentialId).not.toHaveBeenCalled();
	});
});
