import { randomUUID } from "node:crypto";
import {
	mkdtemp,
	readdir,
	readFile,
	rm,
	truncate,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildVodInputSourcePreviewDocument,
	type VodInputPreviewRequest,
} from "@bitovp/core/vod-input-timeline";
import {
	type ObjectStorageBrowser,
	ObjectVersionMismatchError,
} from "@bitovp/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	MediaOperationError,
	type runMediaProcess,
} from "../library-editing/process";
import { renderVodInputPreview } from "./media";

const source = {
	key: "a",
	credentialId: "00000000-0000-4000-8000-000000000001",
	bucket: "media",
	objectKey: "a.mp4",
};
const identity = { size: 1000, etag: '"pinned-v1"' };
const facts = {
	key: "a",
	durationMs: 2000,
	identity,
	video: {
		streamIndex: 0,
		width: 320,
		height: 180,
		displayAspectRatio: { num: 16, den: 9 },
	},
	audio: { streamIndex: 1, sampleRate: 48000, channels: 2 },
};
const placed = () => ({
	id: randomUUID(),
	sourceKey: "a",
	startMs: 0,
	inMs: 0,
	outMs: 1000,
});
function request(): Extract<VodInputPreviewRequest, { kind: "PREVIEW" }> {
	return {
		kind: "PREVIEW",
		probeId: randomUUID(),
		document: {
			schemaVersion: 2,
			id: randomUUID(),
			audioEnabled: true,
			durationMs: 1000,
			videoClips: [placed()],
			audioClips: [placed()],
		},
		range: { startMs: 0, durationMs: 1000 },
	};
}
const repeatedPreview = () => {
	const preview = request();
	if (preview.document.schemaVersion !== 2) throw new Error("Expected v2");
	const parts = () =>
		[0, 375, 750].map((startMs) => ({ ...placed(), startMs, outMs: 375 }));
	preview.document.videoClips = parts();
	preview.document.audioClips = parts();
	preview.document.durationMs = 1125;
	preview.range.durationMs = 1125;
	return preview;
};
let directory: string;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "bitovp-vod-render-guard-"));
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe("independent preview resource and identity guards", () => {
	it.each([
		{ sourceVersion: { versionId: "stable-v1" }, reusable: true },
		{ sourceVersion: { generation: "12345" }, reusable: true },
		{ sourceVersion: { versionId: "null" }, reusable: false },
		{ sourceVersion: {}, reusable: false },
	])("renders repeated part inputs with source identity $sourceVersion", async ({
		sourceVersion,
		reusable,
	}) => {
		const frameCounts: string[] = [];
		const inputs = new Map<string, string>();
		const execute = vi.fn<typeof runMediaProcess>(async (_binary, argv) => {
			if (argv.includes("-show_streams"))
				return {
					stdout: JSON.stringify({
						format: { duration: "1.125" },
						streams: [
							{
								codec_type: "video",
								codec_name: "h264",
								width: 640,
								height: 360,
							},
							{
								codec_type: "audio",
								codec_name: "aac",
								sample_rate: 48000,
								channels: 2,
							},
						],
					}),
					stderr: "",
				};
			const output = argv.at(-1);
			if (!output) throw new Error("Missing fixture output");
			if (argv.includes("-frames:v"))
				frameCounts.push(argv[argv.indexOf("-frames:v") + 1] ?? "");
			if (output.endsWith("/preview.mp4"))
				for (const track of ["video", "audio"])
					inputs.set(
						track,
						await readFile(join(directory, `${track}-parts.txt`), "utf8"),
					);
			await writeFile(output, "media");
			return { stdout: "", stderr: "" };
		});
		const result = await renderVodInputPreview({
			request: repeatedPreview(),
			sources: [source],
			facts: [{ ...facts, identity: { ...identity, ...sourceVersion } }],
			directory,
			browserFor: vi.fn(),
			signal: new AbortController().signal,
			execute,
		});
		expect(frameCounts).toEqual(reusable ? ["11", "12"] : ["11", "12", "11"]);
		expect(inputs.get("video")).toBe(
			(reusable ? [0, 1, 0] : [0, 1, 2])
				.map((index) => `file 'video-part-${index}.mp4'\n`)
				.join(""),
		);
		expect(inputs.get("audio")).toBe(
			(reusable ? [0, 0, 0] : [0, 1, 2])
				.map((index) => `file 'audio-part-${index}.wav'\n`)
				.join(""),
		);
		expect(result.durationMs).toBe(1125);
		expect(await readdir(directory)).toEqual(["preview.mp4"]);
	});
	it("charges the logical byte limit for reused occurrences", async () => {
		const execute = vi.fn<typeof runMediaProcess>(async (_binary, argv) => {
			const output = argv.at(-1);
			if (!output) throw new Error("Missing fixture output");
			await writeFile(output, "");
			await truncate(output, 48 * 1024 ** 2);
			return { stdout: "", stderr: "" };
		});
		await expect(
			renderVodInputPreview({
				request: repeatedPreview(),
				sources: [source],
				facts: [
					{ ...facts, identity: { ...identity, versionId: "stable-v1" } },
				],
				directory,
				browserFor: vi.fn(),
				signal: new AbortController().signal,
				execute,
			}),
		).rejects.toMatchObject({ code: "OUTPUT_LIMIT" });
		expect(execute).toHaveBeenCalledTimes(2);
		expect(await readdir(directory)).toEqual([]);
	});
	it.each([
		false,
		true,
	])("accepts only the natural 4s video/18s audio source audition (edited=%s)", async (edited) => {
		const longFacts = {
			...facts,
			durationMs: 4000,
			video: { ...facts.video, durationMs: 4000 },
			audio: { ...facts.audio, durationMs: 18000 },
		};
		const document = buildVodInputSourcePreviewDocument(longFacts, {
			documentId: randomUUID(),
			clipId: randomUUID(),
		});
		if (edited) {
			const first = document.audioClips[0];
			if (!first) throw new Error("Expected audio");
			first.outMs = 17000;
		}
		const execute = vi.fn(async () => {
			throw new MediaOperationError("FIXTURE_REACHED_RENDER");
		});
		await expect(
			renderVodInputPreview({
				request: {
					kind: "PREVIEW",
					probeId: randomUUID(),
					sourcePreviewKey: "a",
					document,
					range: { startMs: 0, durationMs: 18000 },
				},
				sources: [source],
				facts: [longFacts],
				directory,
				browserFor: vi.fn(),
				signal: new AbortController().signal,
				execute,
			}),
		).rejects.toMatchObject({
			code: edited ? "SOURCE_PREVIEW_INVALID" : "FIXTURE_REACHED_RENDER",
		});
		expect(execute).toHaveBeenCalledTimes(edited ? 0 : 1);
	});
	it.each([
		"PROCESS_FAILED",
		"CANCELED",
	])("removes both passes' partial media when the audio pass ends with %s", async (code) => {
		const controller = new AbortController();
		const execute = vi.fn<typeof runMediaProcess>(
			async (_binary, argv, options) => {
				expect(options?.signal).toBe(controller.signal);
				expect(options?.timeoutMs).toBeGreaterThan(0);
				expect(options?.timeoutMs).toBeLessThanOrEqual(1000);
				expect(options?.maxOutputBytes).toBe(1024 ** 2);
				const output = argv.at(-1);
				if (!output) throw new Error("Missing fixture output");
				await writeFile(output, "partial");
				if (output.endsWith(".wav")) {
					if (code === "CANCELED") controller.abort();
					throw new MediaOperationError(code);
				}
				return { stdout: "", stderr: "" };
			},
		);
		await expect(
			renderVodInputPreview({
				request: request(),
				sources: [source],
				facts: [facts],
				directory,
				browserFor: vi.fn(),
				signal: controller.signal,
				timeoutMs: 1000,
				execute,
			}),
		).rejects.toMatchObject({ code });
		expect(execute).toHaveBeenCalledTimes(2);
		expect(await readdir(directory)).toEqual([]);
	});
	it("keeps object-version enforcement active during the second media pass", async () => {
		const browserFor = async (): Promise<ObjectStorageBrowser> => ({
			listBuckets: async () => [],
			listObjects: async () => ({ objects: [], prefixes: [] }),
			headObject: async () => identity,
			getObject: async () => {
				throw new ObjectVersionMismatchError(
					source.bucket,
					source.objectKey,
					identity,
				);
			},
		});
		const execute = vi.fn<typeof runMediaProcess>(async (_binary, argv) => {
			const output = argv.at(-1);
			if (!output) throw new Error("Missing fixture output");
			await writeFile(output, "partial");
			if (output.endsWith(".wav")) {
				const url = argv[argv.indexOf("-i") + 1];
				if (!url) throw new Error("Missing registered source URL");
				await fetch(url, { headers: { range: "bytes=0-999" } });
				throw new MediaOperationError("PROCESS_FAILED");
			}
			return { stdout: "", stderr: "" };
		});
		await expect(
			renderVodInputPreview({
				request: request(),
				sources: [source],
				facts: [facts],
				directory,
				browserFor,
				signal: new AbortController().signal,
				execute,
			}),
		).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
		expect(execute).toHaveBeenCalledTimes(2);
		expect(await readdir(directory)).toEqual([]);
	});
	it("rejects a native-unrepresentable gap before any CPU render or storage access", async () => {
		const input = request();
		if (input.document.schemaVersion !== 2) throw new Error("Expected v2");
		input.document.audioEnabled = false;
		input.document.durationMs = 12000;
		input.document.videoClips[0] = { ...placed(), startMs: 10001 };
		input.range = { startMs: 10001, durationMs: 1000 };
		const browserFor = vi.fn(),
			execute = vi.fn();
		await expect(
			renderVodInputPreview({
				request: input,
				sources: [source],
				facts: [facts],
				directory,
				browserFor,
				signal: new AbortController().signal,
				execute,
			}),
		).rejects.toMatchObject({ code: "TIMELINE_GAP_TOO_LONG" });
		expect(browserFor).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
	});
});
