import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
	encodingPlanSchema,
	enumerateExistingHlsQcTargets,
} from "@bitovp/core";
import type { ObjectStorageBrowser } from "@bitovp/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireHlsQcOutput } from "./hls-source";

const jobId = "00000000-0000-4000-8000-000000000003";
const retainedSha256 = createHash("sha256")
	.update("INITFIRSTLAST")
	.digest("hex");
const retainedKey = `run/video/qc-retained/${jobId}/v-${retainedSha256}.mp4`;
const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function fixture(media?: string) {
	const jobDir = await mkdtemp(join(tmpdir(), "hdr-hls-qc-"));
	directories.push(jobDir);
	const plan = encodingPlanSchema.parse({
		planVersion: 1,
		name: "HDR HLS",
		generation: { timing: "POST_ENCODING" },
		bitmovin: { accountId: "00000000-0000-4000-8000-000000000001" },
		inputs: [{ key: "in", kind: "S3", credentialId: jobId, bucket: "input" }],
		outputs: [
			{ key: "out", kind: "S3", credentialId: jobId, bucket: "output" },
		],
		dolbyStreams: [
			{
				key: "dv",
				kind: "VISION",
				inputKey: "in",
				videoInputPath: "source.mxf",
			},
		],
		renditions: [
			{
				key: "v",
				codec: "AV1",
				ingestKey: "dv",
				width: 3840,
				height: 2160,
				bitrate: 8000000,
				rate: 24,
				dynamicRangeFormat: "DOLBY_VISION_PROFILE_10_1",
			},
		],
		muxings: [
			{
				key: "mux",
				kind: "FMP4",
				streamKey: "v",
				segmentLength: 2,
				segmentNaming: "seg_%number%.m4s",
				initSegmentName: "init.mp4",
				destination: { outputKey: "out", path: "run/video/" },
			},
		],
		manifests: [
			{
				key: "hls",
				kind: "HLS",
				manifestName: "master.m3u8",
				destination: { outputKey: "out", path: "run/" },
			},
		],
	});
	const [target] = enumerateExistingHlsQcTargets(plan);
	if (!target) throw new Error("Invalid fixture target");
	const objects = new Map<string, Buffer>([
		[
			"run/master.m3u8",
			Buffer.from(
				'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=8000000,CODECS="av01.0.12M.10",RESOLUTION=3840x2160,VIDEO-RANGE=PQ\nvideo.m3u8\n',
			),
		],
		[
			"run/video.m3u8",
			Buffer.from(
				media ??
					'#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI="video/init.mp4"\n#EXTINF:2,\nvideo/seg_0.m4s\n#EXTINF:1,\nvideo/seg_1.m4s\n#EXT-X-ENDLIST\n',
			),
		],
		["run/video/init.mp4", Buffer.from("INIT")],
		["run/video/seg_0.m4s", Buffer.from("FIRST")],
		["run/video/seg_1.m4s", Buffer.from("LAST")],
	]);
	const missing = () =>
		Object.assign(new Error("missing"), {
			name: "NoSuchKey",
			$metadata: { httpStatusCode: 404 },
		});
	const getObject = vi.fn(
		async ({
			key,
			expect: version,
		}: {
			key: string;
			expect?: { etag?: string };
		}) => {
			const bytes = objects.get(key);
			if (!bytes) throw missing();
			if (version?.etag !== '"version-1"')
				throw new Error("conditional read required");
			return Readable.from([bytes]);
		},
	);
	const headObject = vi.fn(async ({ key }: { key: string }) => {
		const bytes = objects.get(key);
		if (!bytes) throw missing();
		return { size: bytes.length, etag: '"version-1"' };
	});
	const putObject = vi.fn(
		async ({ key, filePath }: { key: string; filePath: string }) => {
			objects.set(key, await readFile(filePath));
		},
	);
	const browser = {
		getObject,
		headObject,
		putObject,
		listBuckets: async () => [],
		listObjects: async () => ({ prefixes: [], objects: [] }),
	} satisfies ObjectStorageBrowser;
	return {
		args: { target, vmafJobId: jobId, bucket: "output", jobDir, browser },
		objects,
		getObject,
		headObject,
		putObject,
	};
}

describe("existing fMP4 HDR QC acquisition", () => {
	it("retains exact init-plus-fragment bytes and immutable complete witnesses", async () => {
		const f = await fixture();
		const captured = await acquireHlsQcOutput(f.args);
		const bytes = await readFile(captured.path);
		expect(bytes.toString()).toBe("INITFIRSTLAST");
		expect(f.objects.get(retainedKey)).toEqual(bytes);
		expect(captured.provenance).toMatchObject({
			bucket: "output",
			key: retainedKey,
			bytes: bytes.length,
			pinned: true,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			identity: { etag: '"version-1"' },
		});
		expect(captured.hlsSource).toMatchObject({
			vmafJobId: jobId,
			segmentCount: 2,
			assembledBytes: bytes.length,
			durationSeconds: 3,
			complete: true,
		});
		expect(captured.hlsSource.objects).toHaveLength(5);
		expect(captured.target.distorted.path).toBe(retainedKey);
		expect(
			f.getObject.mock.calls.every(
				([arg]) => arg.expect?.etag === '"version-1"',
			),
		).toBe(true);
	});
	it("keeps different delivery captures for the same QC job at different retained keys", async () => {
		const f = await fixture();
		const first = await acquireHlsQcOutput(f.args);
		const oldBytes = Buffer.from("INITFIRSTLAST");
		const other = await fixture();
		f.objects.set("run/video/seg_0.m4s", Buffer.from("SECOND"));
		const originalHead = f.headObject.getMockImplementation(),
			originalGet = f.getObject.getMockImplementation();
		if (!originalHead || !originalGet)
			throw new Error("Missing storage fixture");
		f.headObject.mockImplementation(async (input) => ({
			...(await originalHead(input)),
			...(input.key === "run/video/seg_0.m4s" ? { etag: '"version-2"' } : {}),
		}));
		f.getObject.mockImplementation(async (input) => {
			if (input.key !== "run/video/seg_0.m4s") return originalGet(input);
			if (input.expect?.etag !== '"version-2"')
				throw new Error("Expected recaptured version");
			return Readable.from([Buffer.from("SECOND")]);
		});
		const second = await acquireHlsQcOutput({
			...f.args,
			jobDir: other.args.jobDir,
		});
		expect(second.provenance.key).not.toBe(first.provenance.key);
		expect(f.objects.get(first.provenance.key)).toEqual(oldBytes);
		expect(f.objects.get(second.provenance.key)).toEqual(
			Buffer.from("INITSECONDLAST"),
		);
		expect(f.putObject).toHaveBeenCalledTimes(2);
	});
	it.each([
		["external URI", "https://elsewhere.example/seg_1.m4s"],
		["escaped path", "../other/seg_1.m4s"],
		["wrong init", "video/other.mp4"],
		["missing ENDLIST", "missing-endlist"],
		["repeated segment", "repeated"],
		["wrong segment name", "video/unrelated.m4s"],
	])("refuses %s without publishing", async (kind, value) => {
		const f = await fixture();
		let media = f.objects.get("run/video.m3u8")?.toString() ?? "";
		media =
			kind === "wrong init"
				? media.replace("video/init.mp4", value)
				: kind === "missing ENDLIST"
					? media.replace("#EXT-X-ENDLIST", "")
					: kind === "repeated segment"
						? media.replace("video/seg_1.m4s", "video/seg_0.m4s")
						: media.replace("video/seg_1.m4s", value);
		f.objects.set("run/video.m3u8", Buffer.from(media));
		await expect(acquireHlsQcOutput(f.args)).rejects.toThrow();
		expect(f.putObject).not.toHaveBeenCalled();
	});
	it("refuses a replaced retained object instead of overwriting it", async () => {
		const f = await fixture();
		f.objects.set(retainedKey, Buffer.from("OTHEROBJECT!"));
		await expect(acquireHlsQcOutput(f.args)).rejects.toThrow();
		expect(f.putObject).not.toHaveBeenCalled();
	});
	it("reuses an identical retained object after verifying its bytes", async () => {
		const f = await fixture();
		f.objects.set(retainedKey, Buffer.from("INITFIRSTLAST"));
		expect((await acquireHlsQcOutput(f.args)).provenance.pinned).toBe(true);
		expect(f.putObject).not.toHaveBeenCalled();
	});
	it("honors cancellation before reading storage", async () => {
		const f = await fixture();
		const controller = new AbortController();
		controller.abort();
		await expect(
			acquireHlsQcOutput({ ...f.args, signal: controller.signal }),
		).rejects.toThrow();
		expect(f.getObject).not.toHaveBeenCalled();
		expect(f.putObject).not.toHaveBeenCalled();
	});
	it("aborts a stalled transfer and removes only its own scratch files", async () => {
		const f = await fixture(),
			source = new Readable({ read() {} });
		f.getObject.mockResolvedValueOnce(source);
		const controller = new AbortController();
		const pending = acquireHlsQcOutput({
			...f.args,
			signal: controller.signal,
		});
		const handled = pending.catch((error: unknown) => error);
		await vi.waitFor(() => expect(f.getObject).toHaveBeenCalled());
		controller.abort();
		expect(await handled).toBeInstanceOf(Error);
		expect(source.destroyed).toBe(true);
		expect(f.putObject).not.toHaveBeenCalled();
		expect(await readdir(f.args.jobDir)).toEqual([]);
	});
	it("accepts HLG declaration for the explicit HDR normalization protocol", async () => {
		const f = await fixture();
		const master = f.objects
			.get("run/master.m3u8")
			?.toString()
			.replace("VIDEO-RANGE=PQ", "VIDEO-RANGE=HLG");
		if (!master) throw new Error("Missing master");
		f.objects.set("run/master.m3u8", Buffer.from(master));
		expect((await acquireHlsQcOutput(f.args)).hlsSource.complete).toBe(true);
	});
});
