import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ObjectStorageBrowser } from "@bitovp/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	downloadPinnedEditingMedia,
	inspectEditingProbe,
	probeEditingMedia,
} from "./media";

const processRun = vi.hoisted(() => vi.fn());
vi.mock("./process", async (original) => ({
	...(await original<typeof import("./process")>()),
	runMediaProcess: processRun,
}));

let dir: string;
beforeEach(async () => {
	processRun.mockReset();
	dir = await mkdtemp(join(tmpdir(), "bitovp-edit-test-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const identity = { size: 4, etag: '"original"', versionId: "version-1" };
function browser(data: string): ObjectStorageBrowser {
	return {
		listBuckets: async () => [],
		listObjects: async () => ({ objects: [], prefixes: [] }),
		headObject: async () => identity,
		getObject: async ({ expect: version }) => {
			if (
				version?.etag !== identity.etag ||
				version.versionId !== identity.versionId
			)
				throw new Error("unqualified read");
			return Readable.from([Buffer.from(data)]);
		},
	};
}

describe("fixed editing media download", () => {
	it("conditions the read on the recorded version and hashes complete bytes", async () => {
		const path = join(dir, "source.mp4");
		const result = await downloadPinnedEditingMedia({
			browser: browser("1234"),
			bucket: "media",
			key: "source",
			destinationPath: path,
		});
		expect(result.identity).toEqual(identity);
		expect(result.sha256).toBe(
			createHash("sha256").update("1234").digest("hex"),
		);
		expect(await readFile(path, "utf8")).toBe("1234");
	});
	it("does not record a short read and removes the partial download", async () => {
		await expect(
			downloadPinnedEditingMedia({
				browser: browser("12"),
				bucket: "media",
				key: "source",
				destinationPath: join(dir, "short.mp4"),
			}),
		).rejects.toMatchObject({ code: "SOURCE_INCOMPLETE" });
		expect(await readdir(dir)).toEqual([]);
	});
	it("enforces a stored hash when the object is reopened", async () => {
		await expect(
			downloadPinnedEditingMedia({
				browser: browser("1234"),
				bucket: "media",
				key: "source",
				destinationPath: join(dir, "changed.mp4"),
				expectedSha256: "0".repeat(64),
			}),
		).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
		expect(await readdir(dir)).toEqual([]);
	});
	it("refuses an object without a usable version selector", async () => {
		const input = browser("1234");
		input.headObject = async () => ({ size: 4 });
		await expect(
			downloadPinnedEditingMedia({
				browser: input,
				bucket: "media",
				key: "source",
				destinationPath: join(dir, "unverified.mp4"),
			}),
		).rejects.toMatchObject({ code: "SOURCE_UNVERIFIED" });
	});
	it("applies the byte ceiling before transferring", async () => {
		await expect(
			downloadPinnedEditingMedia({
				browser: browser("1234"),
				bucket: "media",
				key: "source",
				destinationPath: join(dir, "large.mp4"),
				maxBytes: 3,
			}),
		).rejects.toMatchObject({ code: "SOURCE_TOO_LARGE" });
	});
	it("can cancel while storage is still resolving the object identity", async () => {
		const input = browser("1234");
		input.headObject = () => new Promise(() => {});
		const controller = new AbortController();
		const pending = downloadPinnedEditingMedia({
			browser: input,
			bucket: "media",
			key: "source",
			destinationPath: join(dir, "canceled.mp4"),
			signal: controller.signal,
		});
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: "CANCELED" });
		expect(await readdir(dir)).toEqual([]);
	});
});

function supportedProbe() {
	return {
		streams: [
			{
				index: 0,
				codec_type: "video",
				codec_name: "h264",
				codec_tag_string: "avc1",
				width: 320,
				height: 180,
				pix_fmt: "yuv420p",
				field_order: "progressive",
				sample_aspect_ratio: "1:1",
				r_frame_rate: "30/1",
				avg_frame_rate: "30/1",
				start_time: "0.000000",
				duration: "2.000000",
				nb_frames: "60",
				color_transfer: "bt709",
				color_primaries: "bt709",
				color_space: "bt709",
			},
		],
		format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "2.000000" },
	};
}

describe("editing media admission", () => {
	it("admits known SDR square-pixel 30fps media", () => {
		expect(inspectEditingProbe(supportedProbe())).toMatchObject({
			width: 320,
			height: 180,
			durationUs: 2000000,
			hasAudio: false,
		});
	});
	it.each([
		["sample_aspect_ratio", "4:3"],
		["color_transfer", "smpte2084"],
		["avg_frame_rate", "30000/1001"],
		["start_time", "0.500000"],
		["codec_tag_string", "encv"],
	])("refuses unsupported %s instead of silently converting", (key, value) => {
		const probe = supportedProbe();
		const video = probe.streams[0];
		if (!video) throw new Error("Missing test video");
		Object.assign(video, { [key]: value });
		expect(() => inspectEditingProbe(probe)).toThrow();
	});
	it.each([
		"tt",
		"bb",
		"tb",
		"bt",
		"unknown",
		"",
		null,
		undefined,
	])("refuses interlaced or unknown field order %s", (fieldOrder) => {
		const probe = supportedProbe();
		const video = probe.streams[0];
		if (!video) throw new Error("Missing test video");
		Object.assign(video, { field_order: fieldOrder });
		expect(() => inspectEditingProbe(probe)).toThrow("UNSUPPORTED_MEDIA");
	});
	it("refuses a missing field order instead of assuming progressive", () => {
		const probe = supportedProbe();
		const video = probe.streams[0];
		if (!video) throw new Error("Missing test video");
		Reflect.deleteProperty(video, "field_order");
		expect(() => inspectEditingProbe(probe)).toThrow("UNSUPPORTED_MEDIA");
	});
	it.each([
		undefined,
		"N/A",
		"",
		"0",
		"1.5",
	])("refuses unknown or invalid declared frame count %s", (frames) => {
		const probe = supportedProbe();
		const video = probe.streams[0];
		if (!video) throw new Error("Missing test video");
		Object.assign(video, { nb_frames: frames });
		expect(() => inspectEditingProbe(probe)).toThrow("UNSUPPORTED_MEDIA");
	});
	it("requires the video stream duration instead of substituting container duration", () => {
		const probe = supportedProbe();
		const video = probe.streams[0];
		if (!video) throw new Error("Missing test video");
		Object.assign(video, { duration: undefined });
		expect(() => inspectEditingProbe(probe)).toThrow("UNSUPPORTED_MEDIA");
	});
	it("refuses a declaration whose stream duration contradicts its frame count", () => {
		const probe = supportedProbe();
		const video = probe.streams[0];
		if (!video) throw new Error("Missing test video");
		Object.assign(video, { nb_frames: "90" });
		expect(() => inspectEditingProbe(probe)).toThrow("SOURCE_INCOMPLETE");
	});
});

describe("complete decoded media evidence", () => {
	function enqueueProbe(
		declared: number,
		decoded = declared,
		metadataStderr = "",
		decodedStderr = "",
	) {
		const probe = supportedProbe();
		const video = probe.streams[0];
		if (!video) throw new Error("Missing test video");
		Object.assign(video, {
			nb_frames: String(declared),
			duration: (declared / 30).toFixed(6),
		});
		probe.format.duration = String(declared / 30 + 0.02);
		processRun.mockResolvedValueOnce({
			stdout: JSON.stringify(probe),
			stderr: metadataStderr,
		});
		processRun.mockResolvedValueOnce({
			stdout: Array.from({ length: decoded }, (_, index) =>
				(index / 30).toFixed(6),
			).join("\n"),
			stderr: decodedStderr,
		});
	}
	it.each([
		1, 29, 30, 31, 180,
	])("accepts complete %s-frame evidence including rounded fractional durations", async (frames) => {
		enqueueProbe(frames);
		expect(
			await probeEditingMedia({ sourcePath: join(dir, "complete.mp4") }),
		).toMatchObject({
			frameCount: frames,
			durationUs: Math.ceil((frames * 1_000_000) / 30),
		});
		for (const [, args] of processRun.mock.calls) {
			const input = args.indexOf("-i");
			const decoder = args.slice(0, input);
			expect(decoder[decoder.indexOf("-threads") + 1]).toBe("2");
		}
	});
	it.each([
		[180, 90],
		[60, 61],
	])("refuses declared %s frames with %s decoded frames even when PTS is continuous", async (declared, decoded) => {
		enqueueProbe(declared, decoded);
		await expect(
			probeEditingMedia({ sourcePath: join(dir, "incomplete.mp4") }),
		).rejects.toMatchObject({ code: "SOURCE_INCOMPLETE" });
	});
	it.each([
		"metadata",
		"decode",
	])("refuses exit-zero %s probe errors without publishing shorter facts", async (phase) => {
		enqueueProbe(
			60,
			60,
			phase === "metadata" ? "private source path: error" : "",
			phase === "decode" ? "decoder error: private" : "",
		);
		await expect(
			probeEditingMedia({ sourcePath: join(dir, "broken.mp4") }),
		).rejects.toMatchObject({
			code: "SOURCE_INCOMPLETE",
			message: "SOURCE_INCOMPLETE",
		});
	});
});
