import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import meridianHeader from "../../../../packages/core/src/vmaf/__fixtures__/meridian-imf-rgb-header.json";
import type { ProcessRunner } from "../feeder/supervisor";
import { runHdrVmafScore } from "./hdr-score";

const fixture = vi.hoisted(() => ({
	model: "synthetic HDR model fixture",
	id: "hdr_vmaf_v1.1.8_hfr_3d0h_2160",
}));
vi.mock("@bitovp/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@bitovp/core")>();
	const { createHash } = await import("node:crypto");
	// Keep the real file/hash check. Only its model catalogue entry is a test
	// fixture; no real scorer runs and no scientific score is manufactured.
	return {
		...actual,
		HDR_VMAF_MODELS: actual.HDR_VMAF_MODELS.map((model) =>
			model.id === fixture.id
				? {
						...model,
						sha256: createHash("sha256").update(fixture.model).digest("hex"),
					}
				: model,
		),
	};
});

const frameCount = 43093;
const referenceVideo = {
	...meridianHeader.streams[0],
	duration_ts: frameCount,
};
const outputVideo = {
	...referenceVideo,
	codec_name: "av1",
	pix_fmt: "yuv420p10le",
	bits_per_raw_sample: "10",
	avg_frame_rate: "60000/1001",
	color_range: "tv",
	color_space: "bt2020nc",
	color_primaries: "bt2020",
	color_transfer: "smpte2084",
};
const frame = (n: number, output = false) => ({
	...(output ? outputVideo : referenceVideo),
	best_effort_timestamp: n,
	duration: 1,
});

async function runFixture(
	kind: "complete" | "truncated" | "dropped" | "duplicate" | "vfr",
) {
	const root = await mkdtemp(join(tmpdir(), "hdr-mxf-run-"));
	const referencePath = join(root, "ref-0.mp4");
	const modelPath = join(root, "model.json");
	await writeFile(
		referencePath,
		Buffer.from("060e2b34020501010d01020101020400", "hex"),
	);
	await writeFile(modelPath, fixture.model);
	const frames = Array.from(
		{ length: kind === "truncated" ? frameCount - 1 : frameCount },
		(_, n) => frame(n),
	);
	if (kind === "dropped") frames.splice(10, 1);
	if (kind === "duplicate") frames[10] = frame(9);
	if (kind === "vfr" && frames[10]) frames[10].duration = 2;
	const calls: { command: string; args: string[] }[] = [];
	const runner: ProcessRunner = {
		spawn: () => {
			throw new Error("No media process may spawn in this fixture");
		},
		run: vi.fn(async (command, args) => {
			calls.push({ command, args: [...args] });
			if (args.includes("-show_frames")) {
				const population =
					args.at(-1) === referencePath
						? frames
						: Array.from({ length: frames.length }, (_, n) => frame(n, true));
				return {
					code: 0,
					stderr: "",
					stdout: JSON.stringify({
						streams: [{ time_base: "1001/60000" }],
						frames: population,
					}),
				};
			}
			return {
				code: 42,
				stdout: "",
				stderr: "Synthetic scorer stop after input checks",
			};
		}),
	};
	return {
		root,
		calls,
		referencePath,
		run: () =>
			runHdrVmafScore(
				{ runner, ffmpegPath: "ffmpeg-hdr", ffprobePath: "ffprobe-hdr" },
				{
					referencePath,
					distortedPath: join(root, "output.mp4"),
					model: fixture.id,
					modelPath,
					logPath: join(root, "score.json"),
					referenceProbe: JSON.stringify({
						streams: [referenceVideo],
						format: { format_name: "mxf" },
					}),
					distortedProbe: JSON.stringify({ streams: [outputVideo] }),
					referenceColor: "P3_D65_PQ_RGB_FULL",
					decoderThreads: 2,
					threads: 1,
					signal: new AbortController().signal,
				},
			),
	};
}

it("validates all 43093 nominal-clock slots before scoring and uses the same sequential reference mode", async () => {
	const t = await runFixture("complete");
	try {
		await expect(t.run()).rejects.toThrow("HDR_SCORING_FAILED (42)");
		const [reference, output, scorer] = t.calls;
		expect(t.calls).toHaveLength(3);
		expect(reference?.args.slice(-5)).toEqual([
			"-f",
			"mxf",
			"-seekable",
			"0",
			t.referencePath,
		]);
		expect(output?.args).not.toContain("-seekable");
		const inputs =
			scorer?.args.flatMap((arg, n) => (arg === "-i" ? [n] : [])) ?? [];
		expect(inputs).toHaveLength(2);
		expect(
			scorer?.args.slice((inputs[1] ?? 0) - 4, (inputs[1] ?? 0) + 2),
		).toEqual(["-f", "mxf", "-seekable", "0", "-i", t.referencePath]);
		expect(scorer?.args.slice(0, inputs[0])).not.toContain("-seekable");
	} finally {
		await rm(t.root, { recursive: true, force: true });
	}
});

it.each([
	"truncated",
	"dropped",
	"duplicate",
	"vfr",
] as const)("refuses %s nominal-clock source frames before any scorer starts", async (kind) => {
	const t = await runFixture(kind);
	try {
		await expect(t.run()).rejects.toThrow(
			kind === "truncated"
				? "HDR_REFERENCE_FRAME_COVERAGE"
				: "HDR_FRAME_CADENCE",
		);
		expect(t.calls.some((call) => call.args.includes("-filter_complex"))).toBe(
			false,
		);
	} finally {
		await rm(t.root, { recursive: true, force: true });
	}
});
