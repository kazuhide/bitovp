import { beforeEach, expect, it, vi } from "vitest";
import { classifyPath } from "@/lib/auth/gate";
import { evaluateRole } from "@/lib/auth/roles";

const findUnique = vi.fn(),
	outputs = vi.fn(),
	headObject = vi.fn(),
	getObject = vi.fn(),
	dispose = vi.fn(),
	serve = vi.fn(),
	browser = vi.fn();
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({ prisma: { librarySource: { findUnique } } }),
}));
vi.mock("@/lib/server/library-playback", () => ({
	libraryFileOutputsForSource: (...a: unknown[]) => outputs(...a),
}));
vi.mock("@/lib/server/storage", () => ({
	browserForCredentialId: (...a: unknown[]) => browser(...a),
}));
vi.mock("@/lib/server/object-preview", () => ({
	serveObjectPreview: (...a: unknown[]) => serve(...a),
}));

import { GET } from "./route";

const id = "00000000-0000-4000-8000-000000000001";
const path = `/api/library/sources/${id}/media`;
const call = (query = "key=mp4%3Avideo", sourceId = id) =>
	GET(
		new Request(`http://localhost${path}?${query}`, {
			headers: { Range: "bytes=0-1023" },
		}),
		{ params: Promise.resolve({ id: sourceId }) },
	);
const file = {
	key: "mp4:video",
	kind: "MP4",
	credentialId: id,
	bucket: "private",
	path: "retained/video.mp4",
};
beforeEach(() => {
	vi.clearAllMocks();
	findUnique.mockResolvedValue({
		jobId: null,
		snapshot: {
			schemaVersion: 1,
			kind: "VOD_JOB",
			name: "Asset",
			identity: "UNVERIFIED",
			planHash: "hash",
			inputs: [],
			playbackLinks: [],
			qcVerdict: null,
			qcOverriddenAt: null,
			fileOutputs: [file],
		},
	});
	outputs.mockResolvedValue([file]);
	browser.mockResolvedValue({ headObject, getObject, dispose });
	headObject.mockResolvedValue({ size: 10000000, etag: "v1" });
	serve.mockResolvedValue(
		new Response("video", {
			status: 206,
			headers: { "Content-Type": "video/mp4" },
		}),
	);
});
it("uses the protected VIEWER boundary", () => {
	expect(classifyPath(path)).toBe("api-guarded");
	expect(evaluateRole("VIEWER", path, "GET")).toMatchObject({ allowed: true });
});
it.each([
	"",
	"key=x&key=y",
	"key=mp4:video&url=https://evil.test",
	"key=mp4:video&bucket=other",
])("rejects client-controlled storage query %s", async (q) => {
	expect((await call(q)).status).toBe(400);
	expect(findUnique).not.toHaveBeenCalled();
});
it("rejects invalid source IDs", async () => {
	expect((await call("key=x", "invalid")).status).toBe(400);
	expect(findUnique).not.toHaveBeenCalled();
});
it("does not open storage for unknown source or output key", async () => {
	findUnique.mockResolvedValueOnce(null);
	expect((await call()).status).toBe(404);
	expect((await call("key=other")).status).toBe(404);
	expect(browser).not.toHaveBeenCalled();
});
it("serves only the recorded file after source-job deletion, without leaking locators", async () => {
	const response = await call();
	expect(response.status).toBe(206);
	expect(await response.text()).toBe("video");
	expect(response.headers.get("Cache-Control")).toBe("private, no-store");
	expect(headObject).toHaveBeenCalledWith({
		bucket: "private",
		key: "retained/video.mp4",
	});
	expect(dispose).toHaveBeenCalledTimes(1);
	expect(serve.mock.calls[0]?.[2]).toMatchObject({
		credentialId: id,
		bucket: "private",
		key: "retained/video.mp4",
		size: 10000000,
		expect: { size: 10000000, etag: "v1" },
		contentType: "video/mp4",
	});
});
it("serves stored WebM with its validated MIME while retaining range and identity checks", async () => {
	const webm = {
		...file,
		key: "qc-webm:video",
		kind: "WEBM",
		path: "retained/extensionless-object",
	};
	findUnique.mockResolvedValue({
		jobId: null,
		snapshot: {
			schemaVersion: 1,
			kind: "VOD_JOB",
			name: "Asset",
			identity: "UNVERIFIED",
			planHash: "hash",
			inputs: [],
			playbackLinks: [],
			qcVerdict: null,
			qcOverriddenAt: null,
			fileOutputs: [webm],
		},
	});
	outputs.mockResolvedValue([webm]);
	serve.mockImplementation(
		async (_ctx, _req, target) =>
			new Response("video", {
				status: 206,
				headers: { "Content-Type": target.contentType },
			}),
	);
	const response = await call("key=qc-webm%3Avideo");
	expect(response.status).toBe(206);
	expect(response.headers.get("Content-Type")).toBe("video/webm");
	expect(response.headers.get("Cache-Control")).toBe("private, no-store");
	expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
	expect(headObject).toHaveBeenCalledWith({
		bucket: webm.bucket,
		key: webm.path,
	});
	expect(serve.mock.calls[0]?.[1].headers.get("Range")).toBe("bytes=0-1023");
	expect(serve.mock.calls[0]?.[2]).toMatchObject({
		key: webm.path,
		expect: { size: 10000000, etag: "v1" },
		contentType: "video/webm",
	});
	expect(dispose).toHaveBeenCalledOnce();
});

it.each([
	{ size: 0, etag: "x" },
	{ size: 1 },
	{ size: Number.MAX_SAFE_INTEGER + 1, etag: "x" },
])("refuses invalid object identities %#", async (identity) => {
	headObject.mockResolvedValue(identity);
	expect((await call()).status).toBe(409);
	expect(serve).not.toHaveBeenCalled();
	expect(dispose).toHaveBeenCalled();
});
it("redacts storage failure details and always disposes", async () => {
	headObject.mockRejectedValue(new Error("private-secret upstream-host"));
	const response = await call();
	expect(response.status).toBe(502);
	expect(await response.text()).not.toMatch(/private-secret|upstream-host/);
	expect(dispose).toHaveBeenCalled();
});
it("reports a missing stored MP4 separately from a decoder or storage outage", async () => {
	headObject.mockRejectedValue({
		name: "NotFound",
		$metadata: { httpStatusCode: 404 },
		message: "private-bucket private-key",
	});
	const response = await call();
	expect(response.status).toBe(404);
	expect(await response.json()).toEqual({
		error: "Media file not found",
		details: { code: "MEDIA_FILE_NOT_FOUND" },
	});
	expect(response.headers.get("Cache-Control")).toBe("private, no-store");
	expect(serve).not.toHaveBeenCalled();
	expect(dispose).toHaveBeenCalledTimes(1);
});
it.each([
	401, 403,
])("classifies storage read denial without exposing details (%s)", async (status) => {
	headObject.mockRejectedValue({
		name: "AccessDenied",
		$metadata: { httpStatusCode: status },
		message: "private-bucket private-key secret",
	});
	const response = await call();
	expect(response.status).toBe(502);
	expect(await response.json()).toEqual({
		error: "Media storage access denied",
		details: { code: "MEDIA_STORAGE_ACCESS_DENIED" },
	});
	expect(response.headers.get("Cache-Control")).toBe("private, no-store");
	expect(serve).not.toHaveBeenCalled();
	expect(dispose).toHaveBeenCalledTimes(1);
});
it("does not start a canceled request", async () => {
	const a = new AbortController();
	a.abort();
	const response = await GET(
		new Request(`http://localhost${path}?key=x`, { signal: a.signal }),
		{ params: Promise.resolve({ id }) },
	);
	expect(response.status).toBe(408);
	expect(findUnique).not.toHaveBeenCalled();
});
