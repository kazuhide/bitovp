import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const getRow = vi.fn();
vi.mock("./vod-input-previews", async (original) => ({
	...(await original<Record<string, unknown>>()),
	getVodInputPreviewTaskRow: (...args: unknown[]) => getRow(...args),
}));

import { serveVodInputPreviewContent } from "./vod-input-preview-content";

let root: string;
let path: string;
const org = "00000000-0000-4000-8000-000000000001",
	id = "00000000-0000-4000-8000-000000000002",
	token = "00000000-0000-4000-8000-000000000003";
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "vod-preview-http-"));
	vi.stubEnv("VOD_INPUT_PREVIEW_DIR", root);
	path = join(root, org, id, token, "preview.mp4");
	await mkdir(join(root, org, id, token), { recursive: true });
	await writeFile(path, "0123456789");
	getRow.mockResolvedValue({
		organizationId: org,
		id,
		artifactToken: token,
		artifactPath: path,
		artifactSize: 10n,
		artifactSha256: "a".repeat(64),
		kind: "PREVIEW",
		status: "SUCCEEDED",
	});
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
});

it("serves exact private byte ranges and suffix ranges for browser seeking", async () => {
	const range = await serveVodInputPreviewContent(
		new Request("http://test/content", { headers: { range: "bytes=2-5" } }),
		id,
	);
	expect(range.status).toBe(206);
	expect(range.headers.get("Content-Range")).toBe("bytes 2-5/10");
	expect(range.headers.get("Cache-Control")).toBe("private, no-store");
	expect(await range.text()).toBe("2345");
	const suffix = await serveVodInputPreviewContent(
		new Request("http://test/content", { headers: { range: "bytes=-3" } }),
		id,
	);
	expect(await suffix.text()).toBe("789");
});
it.each([
	"bytes=10-20",
	"bytes=5-2",
	"bytes=0-1,3-4",
	"bytes=-0",
	"bytes=-",
])("rejects invalid range %s", async (range) => {
	const response = await serveVodInputPreviewContent(
		new Request("http://test/content", { headers: { range } }),
		id,
	);
	expect(response.status).toBe(416);
});
it("HEAD reports size without reading a body", async () => {
	const response = await serveVodInputPreviewContent(
		new Request("http://test/content", { method: "HEAD" }),
		id,
	);
	expect(response.headers.get("Content-Length")).toBe("10");
	expect(await response.text()).toBe("");
});
it("does not follow an adopted artifact symlink", async () => {
	const external = join(root, "outside.mp4");
	await writeFile(external, "secretdata");
	await rm(path);
	await symlink(external, path);
	await expect(
		serveVodInputPreviewContent(new Request("http://test/content"), id),
	).rejects.toMatchObject({ code: "PREVIEW_NOT_FOUND" });
});
