import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ObjectStorageBrowser } from "@bitovp/storage";
import { ObjectVersionMismatchError } from "@bitovp/storage";
import { afterEach, describe, expect, it, vi } from "vitest";

const remux = vi.hoisted(() => vi.fn());
vi.mock("./process", async (original) => ({
	...(await original<object>()),
	runMediaProcess: remux,
}));

import { prepareHlsEditingSource } from "./hls-source";

const digest = (b: string | Buffer) =>
	createHash("sha256").update(b).digest("hex");
const directories: string[] = [];
afterEach(async () => {
	remux.mockReset();
	await Promise.all(
		directories.splice(0).map((p) => rm(p, { recursive: true, force: true })),
	);
});
async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "hls-source-unit-"));
	directories.push(directory);
	const files = new Map<string, Buffer>(
		Object.entries({
			"out/master.m3u8":
				'#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=320x180,AUDIO="a"\nvideo.m3u8\n',
			"out/video.m3u8":
				'#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI="v-init.mp4"\n#EXTINF:2,\nv.m4s\n#EXT-X-ENDLIST\n',
			"out/audio.m3u8":
				'#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI="a-init.mp4"\n#EXTINF:2,\na.m4s\n#EXT-X-ENDLIST\n',
			"out/v-init.mp4": "video init bytes",
			"out/a-init.mp4": "audio init bytes",
			"out/v.m4s": "video segment bytes",
			"out/a.m4s": "audio segment bytes",
		}).map(([k, v]) => [k, Buffer.from(v)]),
	);
	const head = vi.fn(async ({ key }: { key: string }) => {
		const b = files.get(key);
		if (!b) throw Error("missing fixture object");
		return { size: b.length, etag: `"${digest(b)}"` };
	});
	const get = vi.fn(
		async ({ key, expect }: { key: string; expect?: { etag?: string } }) => {
			const b = files.get(key);
			if (!b) throw Error("missing fixture object");
			if (expect?.etag !== `"${digest(b)}"`)
				throw new ObjectVersionMismatchError("bucket", key, expect ?? {});
			return Readable.from([b]);
		},
	);
	const browser = {
		headObject: head,
		getObject: get,
		listBuckets: async () => [],
		listObjects: async () => ({ objects: [], prefixes: [] }),
	} satisfies ObjectStorageBrowser;
	const root = files.get("out/master.m3u8");
	if (!root) throw Error("fixture missing");
	const input = {
		browser,
		source: {
			credentialId: "00000000-0000-4000-8000-000000000001",
			bucket: "bucket",
			key: "out/master.m3u8",
			size: root.length,
			expect: { etag: `"${digest(root)}"` },
		},
		rootPrefix: "out/",
		directory,
	};
	remux.mockImplementation(async (_binary, argv: string[]) => {
		if (argv.includes("-show_entries"))
			return {
				stdout: JSON.stringify({
					streams: argv.some((arg) => arg.endsWith("selected-audio.m3u8"))
						? [{ codec_type: "audio" }]
						: [{ codec_type: "video", start_pts: 0, time_base: "1/90000" }],
				}),
				stderr: "",
			};
		await writeFile(
			argv.at(-1) ?? "",
			Buffer.from("unit remux bytes, not a native MP4"),
		);
		return { stdout: "", stderr: "" };
	});
	return { input, files, head, get, directory };
}
describe("pinned bounded HLS object capture into owned local remux", () => {
	it("pins every actual object and remux bytes separately, rewrites safe local paths, and runs file-only ffmpeg", async () => {
		const f = await fixture(),
			before = JSON.stringify([...f.files]),
			result = await prepareHlsEditingSource(f.input);
		expect(result.sha256).toBe(digest(await readFile(result.path)));
		expect(result.witness.remuxSha256).toBe(result.sha256);
		expect(result.witness.objects).toHaveLength(7);
		expect(
			result.witness.objects.find((o) => o.key === "out/master.m3u8")?.sha256,
		).not.toBe(result.sha256);
		for (const object of result.witness.objects) {
			expect(object.sha256).toBe(digest(f.files.get(object.key) ?? ""));
			expect(object.expect.etag).toBe(`"${object.sha256}"`);
		}
		expect(f.get.mock.calls.every(([input]) => input.expect?.etag)).toBe(true);
		const argv = remux.mock.calls.find((call) =>
			(call[1] as string[]).includes("copy"),
		)?.[1] as string[];
		expect(argv).toContain("file,pipe");
		expect(argv).toContain("copy");
		expect(argv.join(" ")).not.toMatch(/https?:|s3:|out\//);
		expect(JSON.stringify([...f.files])).toBe(before);
	});
	it("rebases only the measured first-video PTS and records the transport clock", async () => {
		const f = await fixture();
		remux.mockResolvedValueOnce({
			stdout: JSON.stringify({
				streams: [
					{ codec_type: "video", start_pts: 133500, time_base: "1/90000" },
				],
			}),
			stderr: "",
		});
		const result = await prepareHlsEditingSource(f.input);
		expect(result.witness.timestampOrigin).toEqual({
			videoStartPts: 133500,
			timeBase: { num: 1, den: 90000 },
			offsetSeconds: "-1.483333333",
		});
		const argv = remux.mock.calls.find((call) =>
			(call[1] as string[]).includes("copy"),
		)?.[1] as string[];
		expect(argv).toContain("-copyts");
		expect(argv.filter((arg) => arg === "-1.483333333")).toHaveLength(2);
	});
	it("refuses an object changed after HEAD instead of remuxing substitute bytes", async () => {
		const f = await fixture();
		f.get.mockImplementationOnce(async () => {
			throw new ObjectVersionMismatchError("bucket", "out/master.m3u8", {});
		});
		await expect(prepareHlsEditingSource(f.input)).rejects.toMatchObject({
			code: "SOURCE_CHANGED",
		});
		expect(remux).not.toHaveBeenCalled();
	});
	it("rejects a segment replaced after its own HEAD, not just a changed root manifest", async () => {
		const f = await fixture(),
			original = f.get.getMockImplementation();
		if (!original) throw Error("missing fixture getter");
		f.get.mockImplementation(async (input) => {
			if (input.key === "out/v.m4s")
				throw new ObjectVersionMismatchError(
					"bucket",
					input.key,
					input.expect ?? {},
				);
			return original(input);
		});
		await expect(prepareHlsEditingSource(f.input)).rejects.toMatchObject({
			code: "SOURCE_CHANGED",
		});
		expect(remux).not.toHaveBeenCalled();
	});
	it("refuses unknown/oversized identities and never gets a declared 4GiB segment", async () => {
		const f = await fixture();
		f.head.mockImplementation(async ({ key }) =>
			key.endsWith(".m4s")
				? { size: 4 * 1024 ** 3 + 1, etag: '"large"' }
				: {
						size: f.files.get(key)?.length ?? 0,
						etag: `"${digest(f.files.get(key) ?? "")}"`,
					},
		);
		await expect(prepareHlsEditingSource(f.input)).rejects.toMatchObject({
			code: "SOURCE_TOO_LARGE",
		});
		expect(f.get.mock.calls.some(([input]) => input.key.endsWith(".m4s"))).toBe(
			false,
		);
		expect(remux).not.toHaveBeenCalled();
	});
	it("rejects external references before any external object read", async () => {
		const f = await fixture(),
			root = f.files
				.get("out/master.m3u8")
				?.toString()
				.replace("video.m3u8", "https://external.invalid/video.m3u8");
		f.files.set("out/master.m3u8", Buffer.from(root ?? ""));
		const b = f.files.get("out/master.m3u8");
		if (!b) throw Error("missing fixture");
		f.input.source.size = b.length;
		f.input.source.expect.etag = `"${digest(b)}"`;
		await expect(prepareHlsEditingSource(f.input)).rejects.toMatchObject({
			code: "HLS_UNSUPPORTED",
		});
		expect(
			f.get.mock.calls.every(([input]) => input.key.startsWith("out/")),
		).toBe(true);
		expect(remux).not.toHaveBeenCalled();
	});
	it("bounds a stalled object read by one deadline and cleans only owned scratch", async () => {
		const f = await fixture();
		await writeFile(join(f.directory, "keep.txt"), "keep");
		f.get.mockImplementationOnce(() => new Promise(() => {}));
		await expect(
			prepareHlsEditingSource({ ...f.input, timeoutMs: 30 }),
		).rejects.toMatchObject({ code: "TIMED_OUT" });
		expect(await readFile(join(f.directory, "keep.txt"), "utf8")).toBe("keep");
		expect(
			(await readdir(f.directory)).filter((n) => n !== "keep.txt"),
		).toEqual([]);
		expect(remux).not.toHaveBeenCalled();
	});
	it("does not start capture after cancellation", async () => {
		const f = await fixture(),
			controller = new AbortController();
		controller.abort();
		await expect(
			prepareHlsEditingSource({ ...f.input, signal: controller.signal }),
		).rejects.toMatchObject({ code: "CANCELED" });
		expect(f.get).not.toHaveBeenCalled();
		expect(remux).not.toHaveBeenCalled();
	});
});

const measuredVideo = {
	codec_type: "video",
	start_pts: 0,
	time_base: "1/90000",
};
describe("selected HLS inputs retain an unambiguous stream layout", () => {
	it.each([
		{
			name: "muxed video with two audio streams",
			video: [measuredVideo, { codec_type: "audio" }, { codec_type: "audio" }],
			audio: [{ codec_type: "audio" }],
		},
		{
			name: "external audio with two audio streams",
			video: [measuredVideo],
			audio: [{ codec_type: "audio" }, { codec_type: "audio" }],
		},
		{
			name: "external audio with no stream",
			video: [measuredVideo],
			audio: [],
		},
		{
			name: "external audio containing video",
			video: [measuredVideo],
			audio: [measuredVideo, { codec_type: "audio" }],
		},
		{
			name: "external video-only playlist",
			video: [measuredVideo],
			audio: [measuredVideo],
		},
		{
			name: "external audio containing unsupported data",
			video: [measuredVideo],
			audio: [{ codec_type: "audio" }, { codec_type: "data" }],
		},
		{
			name: "video containing unsupported data",
			video: [measuredVideo, { codec_type: "data" }],
			audio: [{ codec_type: "audio" }],
		},
	])("rejects $name before mapping a first stream or remuxing", async ({
		video,
		audio,
	}) => {
		const f = await fixture(),
			original = remux.getMockImplementation();
		if (!original) throw new Error("Missing process fixture");
		remux.mockImplementation((binary, argv: string[]) =>
			argv.includes("-show_entries")
				? Promise.resolve({
						stdout: JSON.stringify({
							streams: argv.some((arg) => arg.endsWith("selected-audio.m3u8"))
								? audio
								: video,
						}),
						stderr: "",
					})
				: original(binary, argv),
		);
		await writeFile(join(f.directory, "keep.txt"), "keep");
		const before = JSON.stringify([...f.files]);
		await expect(prepareHlsEditingSource(f.input)).rejects.toMatchObject({
			code: "HLS_UNSUPPORTED",
		});
		expect(
			remux.mock.calls.some(([, argv]) => (argv as string[]).includes("copy")),
		).toBe(false);
		expect(await readdir(f.directory)).toEqual(["keep.txt"]);
		expect(await readFile(join(f.directory, "keep.txt"), "utf8")).toBe("keep");
		expect(JSON.stringify([...f.files])).toBe(before);
	});
	it.each([
		0, 1, 2,
	])("admits %i muxed audio streams only when at most one is present", async (audioCount) => {
		const f = await fixture(),
			original = remux.getMockImplementation();
		if (!original) throw new Error("Missing process fixture");
		const root = f.files.get("out/video.m3u8");
		if (!root) throw new Error("Missing direct-media fixture");
		f.files.set("out/master.m3u8", root);
		f.input.source.size = root.length;
		f.input.source.expect.etag = `"${digest(root)}"`;
		remux.mockImplementation((binary, argv: string[]) =>
			argv.includes("-show_entries")
				? Promise.resolve({
						stdout: JSON.stringify({
							streams: [
								measuredVideo,
								...Array.from({ length: audioCount }, () => ({
									codec_type: "audio",
								})),
							],
						}),
						stderr: "",
					})
				: original(binary, argv),
		);
		if (audioCount > 1) {
			await expect(prepareHlsEditingSource(f.input)).rejects.toMatchObject({
				code: "HLS_UNSUPPORTED",
			});
			expect(
				remux.mock.calls.some(([, argv]) =>
					(argv as string[]).includes("copy"),
				),
			).toBe(false);
			expect(await readdir(f.directory)).toEqual([]);
		} else {
			const result = await prepareHlsEditingSource(f.input);
			expect(result.witness.audioPlaylistKey).toBeNull();
			expect(await readFile(result.path, "utf8")).toBe(
				"unit remux bytes, not a native MP4",
			);
		}
	});
});
