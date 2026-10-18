import { expect, it } from "vitest";
import { signGcsVmafInput, validateCloudRemoteInput } from "./remote-input";

const provenance = {
	bucket: "test-private-bucket",
	key: "folder/video.mp4",
	sha256: "a".repeat(64),
	bytes: 100,
	pinned: false,
};
it("signs only the fixed GCS endpoint with existing HMAC permission", async () => {
	const signed = await signGcsVmafInput(
		{
			provider: "GCS_HMAC",
			config: { host: "evil.invalid" },
			secret: { accessKey: "GOOGTEST", secret: "test-secret" },
		},
		provenance,
		3600,
	);
	expect(signed).toMatchObject({ sha256: provenance.sha256, bytes: 100 });
	if (!signed) throw new Error("Missing signed input");
	const url = new URL(signed.url);
	expect(url.origin).toBe("https://storage.googleapis.com");
	expect(url.pathname).toBe("/test-private-bucket/folder/video.mp4");
	expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
	expect(url.searchParams.has("X-Amz-Signature")).toBe(true);
	expect(
		await signGcsVmafInput(
			{ provider: "AWS_S3", config: {}, secret: {} },
			provenance,
			3600,
		),
	).toBeUndefined();
});
it("rejects URL, bytes and digest mismatch before cloud upload", () => {
	const input = {
		url: "https://storage.googleapis.com/b/k?X-Amz-Signature=test",
		sha256: provenance.sha256,
		bytes: 100,
	};
	expect(() => validateCloudRemoteInput(input, provenance)).not.toThrow();
	for (const changed of [
		{ ...input, url: "http://storage.googleapis.com/b/k?X-Amz-Signature=test" },
		{ ...input, url: "https://other.invalid/b/k?X-Amz-Signature=test" },
		{ ...input, bytes: 99 },
		{ ...input, sha256: "b".repeat(64) },
	])
		expect(() => validateCloudRemoteInput(changed, provenance)).toThrow();
});
