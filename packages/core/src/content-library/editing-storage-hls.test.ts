import { describe, expect, it } from "vitest";
import { editingMediaStorageSchema } from "./editing-storage";

const id = "00000000-0000-4000-8000-000000000001";
const legacy = {
	source: {
		credentialId: id,
		bucket: "b",
		key: "out/stream.m3u8",
		size: 100,
		expect: { etag: '"pinned"' },
	},
	output: { credentialId: id, bucket: "b", prefix: "out/edits/" },
};
describe("server-only HLS storage descriptors", () => {
	it("preserves legacy FILE JSON without defaults", () => {
		expect(editingMediaStorageSchema.parse(legacy)).toEqual(legacy);
		expect(
			Object.hasOwn(editingMediaStorageSchema.parse(legacy), "sourceFormat"),
		).toBe(false);
	});
	it("requires a paired HLS/root scope covering the pinned manifest", () => {
		const hls = { ...legacy, sourceFormat: "HLS", hlsRootPrefix: "out/" };
		expect(editingMediaStorageSchema.parse(hls)).toEqual(hls);
		expect(
			editingMediaStorageSchema.parse({ ...hls, hlsRootPrefix: "out" }),
		).toEqual({ ...hls, hlsRootPrefix: "out" });
		expect(
			editingMediaStorageSchema.parse({ ...hls, hlsRootPrefix: "" }),
		).toEqual({ ...hls, hlsRootPrefix: "" });
	});
	it.each([
		{ sourceFormat: "HLS" },
		{ hlsRootPrefix: "out/" },
		{ sourceFormat: "DASH", hlsRootPrefix: "out/" },
		{ sourceFormat: "HLS", hlsRootPrefix: "else/" },
		{ sourceFormat: "HLS", hlsRootPrefix: "../out/" },
		{ sourceFormat: "HLS", hlsRootPrefix: "/out/" },
		{ sourceFormat: "HLS", hlsRootPrefix: "out/../" },
		{ sourceFormat: "HLS", hlsRootPrefix: "out\\" },
		{ sourceFormat: "HLS", hlsRootPrefix: "out/\n" },
	])("rejects unpaired or unsafe HLS locator %j", (delta) => {
		expect(
			editingMediaStorageSchema.safeParse({ ...legacy, ...delta }).success,
		).toBe(false);
	});
});
