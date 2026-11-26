import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { VodInputImagePrepareRequest } from "@bitovp/core/vod-input-timeline";
import type { ObjectStorageBrowser } from "@bitovp/storage";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prepareVodInputImage } from "./still-image";

const org = "00000000-0000-4000-8000-000000000001",
	task = "00000000-0000-4000-8000-000000000002",
	attempt = "00000000-0000-4000-8000-000000000003";
let directory: string;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "vod-still-test-"));
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});
const chunk = (name: string, data = Buffer.alloc(0)) => {
	const h = Buffer.alloc(8);
	h.writeUInt32BE(data.length);
	h.write(name, 4);
	return Buffer.concat([h, data, Buffer.alloc(4)]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(320);
ihdr.writeUInt32BE(180, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
	Buffer.from("89504e470d0a1a0a", "hex"),
	chunk("IHDR", ihdr),
	chunk("IDAT", Buffer.from([1])),
	chunk("IEND"),
]);

async function setup() {
	const request: VodInputImagePrepareRequest = {
		kind: "IMAGE_PREPARE",
		source: {
			key: "cover",
			credentialId: org,
			bucket: "input",
			objectKey: "cover.png",
		},
		sourceIdentity: { size: png.length, etag: '"source"' },
		durationMs: 5000,
		output: { credentialId: task, bucket: "output", prefix: "staging" },
	};
	const objects = new Map<string, Buffer>([["cover.png", png]]);
	const headObject = vi.fn(async ({ key }: { key: string }) => ({
		size: objects.get(key)?.length ?? 0,
		etag: key === "cover.png" ? '"source"' : '"ready"',
	}));
	const getObject = vi.fn(
		async ({
			key,
			range,
		}: {
			key: string;
			range?: { start: number; end?: number };
		}) =>
			Readable.from([
				objects
					.get(key)
					?.subarray(
						range?.start ?? 0,
						range?.end === undefined ? undefined : range.end + 1,
					) ?? Buffer.alloc(0),
			]),
	);
	const putObject = vi.fn(
		async ({ key, filePath }: { key: string; filePath: string }) => {
			objects.set(key, await readFile(filePath));
		},
	);
	const browser = {
		listBuckets: async () => [],
		listObjects: async () => ({ objects: [], prefixes: [] }),
		headObject,
		getObject,
		putObject,
	};
	const raw = {
		streams: [
			{
				index: 0,
				codec_type: "video",
				codec_name: "h264",
				width: 1920,
				height: 1080,
				sample_aspect_ratio: "1:1",
				avg_frame_rate: "30/1",
				duration: "5.000000",
				nb_frames: "150",
			},
			{
				index: 1,
				codec_type: "audio",
				codec_name: "aac",
				sample_rate: "48000",
				channels: 2,
				duration: "5.000000",
			},
		],
		format: { duration: "5.000000" },
	};
	const execute = vi.fn(async (command: string, argv: readonly string[]) => {
		if (command === "ffmpeg") {
			await writeFile(argv.at(-1) ?? "", "generated-mp4");
			return { stdout: "", stderr: "" };
		}
		return { stdout: JSON.stringify(raw), stderr: "" };
	});
	const controller = new AbortController();
	const input = {
		request,
		organizationId: org,
		taskId: task,
		attemptId: attempt,
		directory: await mkdtemp(join(directory, "attempt-")),
		browserFor: async () => browser as ObjectStorageBrowser,
		execute,
		signal: controller.signal,
	};
	return { request, browser, objects, raw, execute, controller, input };
}

it("uploads a distinct owned MP4, verifies remote bytes/probe and returns a normal reusable source", async () => {
	const f = await setup(),
		prepared = await prepareVodInputImage(f.input);
	expect(prepared.source).toEqual({
		key: `img_${task.replaceAll("-", "")}`,
		credentialId: task,
		bucket: "output",
		objectKey:
			"staging/bitovp-generated-inputs/" +
			org +
			"/" +
			task +
			"/" +
			attempt +
			".mp4",
	});
	expect(prepared.facts.video?.width).toBe(1920);
	expect(prepared.facts.audio?.durationMs).toBe(5000);
	expect(prepared.requestedDurationMs).toBe(5000);
	expect(prepared.sha256).toBe(
		createHash("sha256").update("generated-mp4").digest("hex"),
	);
	expect(f.objects.get("cover.png")).toEqual(png);
	expect(
		f.browser.getObject.mock.calls.some(
			([arg]) => arg.key === prepared.source.objectKey,
		),
	).toBe(true);
	expect(
		f.execute.mock.calls.find(([command]) => command === "ffmpeg")?.[1],
	).toContain("-noautorotate");
});

it("rejects changed sources and absent output write capability before encoding", async () => {
	for (const mode of ["changed", "no-put"] as const) {
		const f = await setup();
		if (mode === "changed")
			f.browser.headObject.mockImplementation(async () => ({
				size: png.length,
				etag: '"changed"',
			}));
		else Object.assign(f.browser, { putObject: undefined });
		await expect(prepareVodInputImage(f.input)).rejects.toMatchObject({
			code: mode === "changed" ? "SOURCE_CHANGED" : "IMAGE_OUTPUT_UNSUPPORTED",
		});
		expect(f.execute).not.toHaveBeenCalled();
	}
});

it("does not publish a prepared source when stored bytes or the generated clock are wrong", async () => {
	for (const mode of ["bytes", "clock"] as const) {
		const f = await setup();
		if (mode === "bytes")
			f.browser.putObject.mockImplementation(async ({ key, filePath }) => {
				const bytes = await readFile(filePath);
				bytes[0] = 0;
				f.objects.set(key, bytes);
			});
		else {
			const video = f.raw.streams[0];
			if (video) video.duration = "4.900000";
		}
		await expect(prepareVodInputImage(f.input)).rejects.toMatchObject({
			code:
				mode === "bytes" ? "IMAGE_OUTPUT_UNVERIFIED" : "IMAGE_OUTPUT_INVALID",
		});
	}
});
it("prepares enough complete CFR frames to cover a millisecond clip boundary", async () => {
	const f = await setup();
	f.request.durationMs = 1234;
	const video = f.raw.streams[0],
		audio = f.raw.streams[1];
	if (!video || !audio) throw new Error("Missing fixture streams");
	video.duration = "1.266667";
	video.nb_frames = "38";
	audio.duration = "1.266667";
	f.raw.format.duration = "1.266667";
	const prepared = await prepareVodInputImage(f.input);
	expect(prepared.requestedDurationMs).toBe(1234);
	expect(prepared.facts.video?.durationMs).toBe(1266);
	expect(prepared.facts.audio?.durationMs).toBe(1266);
	const argv = f.execute.mock.calls.find(
		([command]) => command === "ffmpeg",
	)?.[1];
	expect(argv?.[Number(argv?.indexOf("-t")) + 1]).toBe(String(38 / 30));
});
