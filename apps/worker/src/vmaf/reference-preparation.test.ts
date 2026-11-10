import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ProcessRunner } from "../feeder/supervisor";
import { prepareDisplayScaleReference } from "./reference-preparation";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const matrix =
	"\n00000000: 34475 0 0\n00000001: 0 34467 0\n00000002: 0 0 1073741824\n";
const video = {
	index: 0,
	codec_type: "video",
	codec_name: "h264",
	width: 1920,
	height: 1080,
	pix_fmt: "yuv420p",
	sample_aspect_ratio: "1:1",
	time_base: "1/2400",
	color_range: "tv",
	color_space: "bt709",
	color_transfer: "bt709",
	color_primaries: "bt709",
	extradata_size: 37,
	extradata_hash: `SHA256:${sha("codec")}`,
};
const sourceProbe = (patch = {}) =>
	JSON.stringify({
		streams: [
			{
				...video,
				side_data_list: [
					{
						side_data_type: "Display Matrix",
						rotation: 0,
						displaymatrix: matrix,
					},
				],
				...patch,
			},
		],
	});

async function setup(
	change?: (kind: string, source: boolean, text: string) => string,
) {
	const directory = await mkdtemp(
		join(tmpdir(), "reference-preparation-test-"),
	);
	directories.push(directory);
	const originalPath = join(directory, "source.mov"),
		preparedPath = join(directory, "prepared.mov");
	await writeFile(originalPath, "source");
	const runner: ProcessRunner = {
		spawn() {
			throw new Error("unexpected spawn");
		},
		async run(_bin, args) {
			const source = args.includes(originalPath);
			if (args.includes("copy") && !args.includes("framehash")) {
				await writeFile(preparedPath, "prepared");
				return { code: 0, stdout: "", stderr: "" };
			}
			const kind = args.includes("-show_packets")
				? "packets"
				: args.includes("framehash")
					? "frames"
					: "probe";
			let text =
				kind === "probe"
					? JSON.stringify({
							streams: [
								{
									...video,
									...(source ? JSON.parse(sourceProbe()).streams[0] : {}),
								},
							],
						})
					: kind === "packets"
						? JSON.stringify({
								packets: [
									{
										stream_index: 0,
										pts: 0,
										dts: -100,
										duration: 100,
										size: "42",
										data_hash: `SHA256:${sha("packet")}`,
									},
								],
							})
						: `#format: frame checksums\n#version: 2\n#hash: SHA256\n#tb 0: 1/2400\n#media_type 0: video\n#codec_id 0: rawvideo\n#dimensions 0: 1920x1080\n#sar 0: 1/1\n0, 0, 0, 100, 3110400, ${sha("frame")}\n`;
			text = change?.(kind, source, text) ?? text;
			const output = args.includes("-o")
				? args[args.indexOf("-o") + 1]
				: args.at(-1);
			if (!output) throw new Error("missing output");
			await writeFile(output, text);
			return { code: 0, stdout: "", stderr: "" };
		},
	};
	return {
		runner,
		ffmpegPath: "ffmpeg",
		ffprobePath: "ffprobe",
		originalPath,
		preparedPath,
		originalProbe: sourceProbe(),
		originalSha256: sha("source"),
	};
}

it("accepts only completely verified coded-raster preservation", async () => {
	const input = await setup();
	const result = await prepareDisplayScaleReference(input);
	expect(result.path).toBe(input.preparedPath);
	expect(result.evidence).toMatchObject({
		method: "LOSSLESS_DISPLAY_SCALE_REMUX",
		comparisonSpace: "CODED_RASTER",
		inputSha256: sha("source"),
		preparedSha256: sha("prepared"),
		preparedBytes: 8,
		sourceDisplayMatrix: [34475, 0, 0, 0, 34467, 0, 0, 0, 1073741824],
		packetCount: 1,
		frameCount: 1,
		packetTimingVerified: true,
		frameTimingVerified: true,
	});
	expect(await readFile(input.originalPath, "utf8")).toBe("source");
});

it("verifies an audio-first source's video packets at index one against the remuxed video at zero", async () => {
	const originalStreams = [
		{ index: 0, codec_type: "audio" },
		{ ...JSON.parse(sourceProbe()).streams[0], index: 1 },
	];
	const input = await setup((kind, source, text) => {
		if (!source) return text;
		if (kind === "probe") return JSON.stringify({ streams: originalStreams });
		if (kind === "packets")
			return text.replace('"stream_index":0', '"stream_index":1');
		return text;
	});
	input.originalProbe = JSON.stringify({ streams: originalStreams });
	const result = await prepareDisplayScaleReference(input);
	expect(result.evidence).toMatchObject({
		packetCount: 1,
		frameCount: 1,
		packetTimingVerified: true,
		frameTimingVerified: true,
	});
	expect(JSON.parse(result.probe).streams[0].index).toBe(0);
});

it.each([
	-1,
	0.5,
	Number.MAX_SAFE_INTEGER + 1,
	"0",
	undefined,
])("rejects invalid selected video index %s", async (index) => {
	const input = await setup();
	await expect(
		prepareDisplayScaleReference({
			...input,
			originalProbe: sourceProbe({ index }),
		}),
	).rejects.toThrow("REFERENCE_PREPARATION_VIDEO_STREAM");
	await expect(readFile(input.preparedPath)).rejects.toThrow();
});

it.each([
	true,
	false,
])("rejects packets belonging to another selected stream (source=%s)", async (isOriginal) => {
	const input = await setup((kind, source, text) =>
		kind === "packets" && source === isOriginal
			? text.replace('"stream_index":0', '"stream_index":1')
			: text,
	);
	await expect(prepareDisplayScaleReference(input)).rejects.toThrow(
		"REFERENCE_PREPARATION_PACKET_TIMING",
	);
	await expect(readFile(input.preparedPath)).rejects.toThrow();
});

it("rejects an invalid freshly probed prepared-video index", async () => {
	const input = await setup((kind, source, text) =>
		kind === "probe" && !source
			? text.replace('"index":0', '"index":-1')
			: text,
	);
	await expect(prepareDisplayScaleReference(input)).rejects.toThrow(
		"REFERENCE_PREPARATION_VIDEO_STREAM",
	);
	await expect(readFile(input.preparedPath)).rejects.toThrow();
});

it.each([
	"packets",
	"frames",
	"probe",
])("rejects a %s mismatch and removes the prepared copy", async (kind) => {
	const input = await setup((actual, source, text) =>
		actual === kind && !source
			? text.replace(
					kind === "probe"
						? '"time_base":"1/2400"'
						: sha(kind === "packets" ? "packet" : "frame"),
					kind === "probe" ? '"time_base":"1/4800"' : "b".repeat(64),
				)
			: text,
	);
	await expect(prepareDisplayScaleReference(input)).rejects.toThrow(
		/REFERENCE_PREPARATION/,
	);
	await expect(readFile(input.preparedPath)).rejects.toThrow();
});

it.each([
	{
		side_data_list: [
			{ side_data_type: "Display Matrix", rotation: 90, displaymatrix: matrix },
		],
	},
	{
		side_data_list: [
			{
				side_data_type: "Display Matrix",
				rotation: 0,
				displaymatrix: matrix.replace("34475", "-34475"),
			},
		],
	},
	{
		side_data_list: [
			{
				side_data_type: "Display Matrix",
				rotation: 0,
				displaymatrix: matrix.replace("34475 0 0", "34475 1 0"),
			},
		],
	},
	{ side_data_list: [{ side_data_type: "Display Matrix", rotation: 0 }] },
	{ tags: { rotate: "90" } },
	{ sample_aspect_ratio: "2:1" },
	{ color_transfer: "smpte2084" },
	{ codec_name: "hevc" },
	{
		side_data_list: [
			{
				side_data_type: "Display Matrix",
				rotation: 0,
				displaymatrix: matrix.replace("34475 0 0", "34475 0 1"),
			},
		],
	},
	{
		side_data_list: [
			{
				side_data_type: "Display Matrix",
				rotation: 0,
				displaymatrix: matrix.replace("0 0 1073741824", "1 0 1073741824"),
			},
		],
	},
	{
		side_data_list: [
			{ side_data_type: "Display Matrix", rotation: 0, displaymatrix: matrix },
			{
				side_data_type: "Frame Cropping",
				crop_top: 1,
				crop_bottom: 0,
				crop_left: 0,
				crop_right: 0,
			},
		],
	},
	{
		side_data_list: [
			{ side_data_type: "Display Matrix", rotation: 0, displaymatrix: matrix },
			{ side_data_type: "Unknown display metadata" },
		],
	},
])("rejects an unsupported source without preparing media: %j", async (patch) => {
	const input = await setup();
	await expect(
		prepareDisplayScaleReference({
			...input,
			originalProbe: sourceProbe(patch),
		}),
	).rejects.toThrow(/REFERENCE_PREPARATION/);
	await expect(readFile(input.preparedPath)).rejects.toThrow();
});

it("rejects an already cancelled request and a changed source hash", async () => {
	const input = await setup();
	const signal = AbortSignal.abort();
	await expect(
		prepareDisplayScaleReference({ ...input, signal }),
	).rejects.toThrow();
	await expect(
		prepareDisplayScaleReference({ ...input, originalSha256: "0".repeat(64) }),
	).rejects.toThrow(/REFERENCE_PREPARATION/);
});

it("retains an existing destination and the original when the destination is unavailable", async () => {
	const input = await setup();
	await writeFile(input.preparedPath, "user file");
	await expect(prepareDisplayScaleReference(input)).rejects.toThrow();
	expect(await readFile(input.preparedPath, "utf8")).toBe("user file");
	expect(await readFile(input.originalPath, "utf8")).toBe("source");
});

it.each([
	"abort",
	"source-change",
])("removes its prepared copy after %s during processing", async (failure) => {
	const input = await setup();
	const originalRun = input.runner.run;
	const controller = new AbortController();
	input.runner.run = async (bin, args, context) => {
		const result = await originalRun(bin, args, context);
		if (args.includes("copy")) {
			if (failure === "abort") controller.abort();
			else await writeFile(input.originalPath, "changed source");
		}
		return result;
	};
	await expect(
		prepareDisplayScaleReference({ ...input, signal: controller.signal }),
	).rejects.toThrow();
	await expect(readFile(input.preparedPath)).rejects.toThrow();
});

it("rejects a prepared file that retains the display transform", async () => {
	const input = await setup((kind, source, text) =>
		kind === "probe" && !source ? sourceProbe() : text,
	);
	await expect(prepareDisplayScaleReference(input)).rejects.toThrow(
		"REFERENCE_PREPARATION_PREPARED_IDENTITY",
	);
	await expect(readFile(input.preparedPath)).rejects.toThrow();
});

it("rejects incomplete packet or decoded-frame coverage", async () => {
	const input = await setup((kind, _source, text) =>
		kind === "packets" ? JSON.stringify({ packets: [] }) : text,
	);
	await expect(prepareDisplayScaleReference(input)).rejects.toThrow(
		"REFERENCE_PREPARATION_PACKET_COVERAGE",
	);
	await expect(readFile(input.preparedPath)).rejects.toThrow();
});

it("rejects oversized probe output without retaining files", async () => {
	const input = await setup((kind, _source, text) =>
		kind === "probe" ? " ".repeat(1024 * 1024 + 1) : text,
	);
	await expect(prepareDisplayScaleReference(input)).rejects.toThrow(
		"REFERENCE_PREPARATION_OUTPUT_LIMIT",
	);
	await expect(readFile(input.preparedPath)).rejects.toThrow();
});

it("rejects a prepared file changed after frame verification", async () => {
	const input = await setup();
	const originalRun = input.runner.run;
	input.runner.run = async (bin, args, context) => {
		const result = await originalRun(bin, args, context);
		if (args.at(-1)?.endsWith("prepared.framehash"))
			await writeFile(input.preparedPath, "changed");
		return result;
	};
	await expect(prepareDisplayScaleReference(input)).rejects.toThrow(
		"REFERENCE_PREPARATION_PREPARED_CHANGED",
	);
	await expect(readFile(input.preparedPath)).rejects.toThrow();
});
