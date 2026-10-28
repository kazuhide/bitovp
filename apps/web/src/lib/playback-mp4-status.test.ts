import { afterEach, expect, it, vi } from "vitest";
import { libraryMp4PlaybackError } from "./playback-mp4-status";

const url =
	"/api/library/sources/00000000-0000-4000-8000-000000000001/media?key=mp4%3Avideo";
afterEach(() => vi.restoreAllMocks());

it.each([
	"https://storage.test/private.mp4",
	"https://other.test/api/library/sources/00000000-0000-4000-8000-000000000001/media?key=x",
	"/api/other?key=x",
])("never probes an external or unrelated URL: %s", async (target) => {
	const fetch = vi.spyOn(globalThis, "fetch");
	expect(
		await libraryMp4PlaybackError(target, new AbortController().signal),
	).toBe(null);
	expect(fetch).not.toHaveBeenCalled();
});

it.each([
	401, 403, 502, 206,
])("does not turn access/outage/decoding into missing media (%s)", async (status) => {
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response("x", { status }),
	);
	expect(await libraryMp4PlaybackError(url, new AbortController().signal)).toBe(
		null,
	);
});

it("requires the explicit missing-file code and sends only a one-byte range", async () => {
	const fetch = vi
		.spyOn(globalThis, "fetch")
		.mockResolvedValueOnce(
			Response.json({ error: "Not found" }, { status: 404 }),
		)
		.mockResolvedValueOnce(
			Response.json(
				{ details: { code: "MEDIA_FILE_NOT_FOUND" } },
				{ status: 404 },
			),
		);
	const signal = new AbortController().signal;
	expect(await libraryMp4PlaybackError(url, signal)).toBeNull();
	expect(await libraryMp4PlaybackError(url, signal)).toBe("missing");
	expect(fetch).toHaveBeenLastCalledWith(url, {
		headers: { Range: "bytes=0-0" },
		cache: "no-store",
		signal,
	});
});

it("does not report absence after a canceled or failed probe", async () => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(
		new DOMException("Aborted", "AbortError"),
	);
	expect(await libraryMp4PlaybackError(url, new AbortController().signal)).toBe(
		null,
	);
});

it("requires an explicit upstream storage access denial code, not an app auth failure", async () => {
	const fetch = vi.spyOn(globalThis, "fetch");
	for (const status of [401, 403, 404, 502]) {
		fetch.mockResolvedValueOnce(
			Response.json(
				{ details: { code: "MEDIA_STORAGE_ACCESS_DENIED" } },
				{ status },
			),
		);
		expect(
			await libraryMp4PlaybackError(url, new AbortController().signal),
		).toBe(status === 502 ? "storage-access-denied" : null);
	}
});

it("probes a bound native media URL without widening its local-route boundary", async () => {
	const url =
		"/api/library/sources/00000000-0000-4000-8000-000000000001/media?key=qc-webm%3Avideo&expectedOrganizationId=00000000-0000-4000-8000-000000000002";
	const fetch = vi
		.spyOn(globalThis, "fetch")
		.mockResolvedValue(new Response("x", { status: 206 }));
	const signal = new AbortController().signal;
	expect(await libraryMp4PlaybackError(url, signal)).toBeNull();
	expect(fetch).toHaveBeenCalledWith(url, {
		headers: { Range: "bytes=0-0" },
		cache: "no-store",
		signal,
	});
});
