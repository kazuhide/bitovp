import { Readable } from "node:stream";
import type { ObjectStorageBrowser } from "@bitovp/storage";
import { expect, it, vi } from "vitest";
import { createStoredAnalysisReader } from "./stored-analysis";

const locator = {
	credentialId: "credential",
	bucket: "bucket",
	path: "output/job/",
	filename: "asset.json",
};
it.each([
	{ locale: "en", key: "output/job/asset.json" },
	{ locale: "ja", key: "output/job/asset_ja.json" },
])("reads the $locale output with a version-pinned, bounded read and disposes the client", async ({
	locale,
	key,
}) => {
	const getObject = vi.fn(async () =>
		Readable.from([JSON.stringify({ metadata: { version: "1.9.0" } })]),
	);
	const dispose = vi.fn();
	const read = createStoredAnalysisReader(
		async () =>
			({
				headObject: async () => ({ size: 32, etag: '"v1"' }),
				getObject,
				dispose,
			}) as unknown as ObjectStorageBrowser,
	);
	expect(await read(locator, locale)).toEqual({
		metadata: { version: "1.9.0" },
	});
	expect(getObject).toHaveBeenCalledWith({
		bucket: "bucket",
		key,
		expect: { etag: '"v1"' },
	});
	expect(dispose).toHaveBeenCalledOnce();
});
it("refuses oversized stored JSON without downloading it", async () => {
	const getObject = vi.fn();
	const read = createStoredAnalysisReader(
		async () =>
			({
				headObject: async () => ({ size: 9 * 1024 * 1024 }),
				getObject,
			}) as unknown as ObjectStorageBrowser,
	);
	await expect(read(locator, "en")).rejects.toThrow("8 MiB");
	expect(getObject).not.toHaveBeenCalled();
});
