import { describe, expect, it } from "vitest";
import type { ResolvedCredential } from "../orchestrator/executor";
import { locate, type VmafDownloadArgs } from "./download";

const args = (over: Partial<VmafDownloadArgs> = {}): VmafDownloadArgs => ({
	credential: {} as ResolvedCredential,
	bucket: "my-bucket",
	key: "out/video/360p/qc/v360.mp4",
	destPath: "/tmp/x.mp4",
	...over,
});

describe("locate (VMAF download error context)", () => {
	it("names the side + bucket/key so a bare 404 becomes actionable", () => {
		const e = locate(
			args({ label: "distorted qc mirror for rendition v360" }),
			new Error("The specified key does not exist."),
		);
		expect(e.message).toBe(
			"distorted qc mirror for rendition v360 (s3://my-bucket/out/video/360p/qc/v360.mp4): The specified key does not exist.",
		);
	});

	it("falls back to a generic label and tolerates a non-Error reason", () => {
		const e = locate(args({ label: undefined, key: "src.mp4" }), "boom");
		expect(e.message).toBe("object (s3://my-bucket/src.mp4): boom");
	});
});
