import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildVmafCommand } from "./command";
import {
	VMAF_SPEED_CHROMA_PRESCALE,
	vmafChromaLayout,
	vmafSizeLimitFailureMessage,
	vmafSizeLimitMessage,
} from "./size-limits";

// The limits of size-limits.ts are numbers of the libvmaf that the worker
// image builds. These tests run the product's own commands with that FFmpeg
// and the image's models, at every edge, and hold the answers of
// size-limits.ts against what FFmpeg does. They need `ffmpeg` on PATH and
// VMAF_MODEL_DIR; the native media job gives both (scripts/gated-tests.mjs).
// With another libvmaf they may fail: the numbers then have to be measured
// again.
const modelDir = process.env.VMAF_MODEL_DIR ?? "";
let ready = false;
if (modelDir) {
	try {
		execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
		ready = true;
	} catch {
		// Real-process coverage is skipped when FFmpeg is unavailable.
	}
}

/** What FFmpeg did with one comparison. */
type Outcome =
	| "scores"
	/** libvmaf's SpEED feature refuses the pictures; FFmpeg then crashes. */
	| "SpEED refuses the pictures"
	/** CAMBI computes nothing for a size below 216 on both sides. */
	| "CAMBI refuses the size"
	/** CAMBI refuses a declared size outside 144 to 7680. */
	| "CAMBI refuses its options";

/**
 * The smallest side of a chroma plane that SpEED takes, for each model: 16
 * times 5 samples, divided by the model's prescale and rounded as libvmaf
 * rounds.
 */
const SMALLEST_CHROMA_SIDE: Record<string, number> = {
	"vmaf_v1.0.16_3d0h": 80,
	"vmaf_v1.0.16_hfr_3d0h": 80,
	"vmaf_v1.0.16_1d5h_2160": 80,
	"vmaf_v1.0.16_hfr_1d5h_2160": 80,
	"vmaf_v1.0.16_5d0h": 133,
	"vmaf_v1.0.16_hfr_5d0h": 133,
	"vmaf_v1.0.16_3d0h_2160": 159,
	"vmaf_v1.0.16_hfr_3d0h_2160": 159,
};
const V1 = "vmaf_v1.0.16_3d0h";

let dir = "";
let runs = 0;
beforeAll(() => {
	if (ready) dir = mkdtempSync(join(tmpdir(), "bitovp-vmaf-size-limits-"));
});
afterAll(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Runs a command of `buildVmafCommand` whose two inputs are lavfi sources. */
function run(
	options: Omit<Parameters<typeof buildVmafCommand>[0], "logPath">,
): { outcome: Outcome | string; stderr: string } {
	runs += 1;
	const logPath = join(dir, `${runs}.json`);
	const argv = buildVmafCommand({
		...options,
		modelPath: join(modelDir, `${options.model}.json`),
		logPath,
	});
	let stderr: string;
	try {
		execFileSync(
			"ffmpeg",
			argv.flatMap((arg) => (arg === "-i" ? ["-f", "lavfi", "-i"] : [arg])),
			{ stdio: ["ignore", "ignore", "pipe"], timeout: 60_000 },
		);
		const log = JSON.parse(readFileSync(logPath, "utf8"));
		return {
			outcome:
				log?.frames?.length === FRAMES &&
				Number.isFinite(log?.pooled_metrics?.vmaf?.mean)
					? "scores"
					: "ends without a score for every frame",
			stderr: "",
		};
	} catch (error) {
		stderr = String((error as { stderr?: unknown }).stderr ?? error);
	}
	return {
		outcome: stderr.includes("SpEED: image too small")
			? "SpEED refuses the pictures"
			: stderr.includes("problem during vmaf_use_features_from_model")
				? "CAMBI refuses its options"
				: stderr.includes("no feature 'cambi")
					? "CAMBI refuses the size"
					: `fails otherwise: ${stderr.trim().split("\n").slice(-2).join(" | ")}`,
		stderr,
	};
}

const FRAMES = 5;
// testsrc2 rounds an odd size down when it draws in a format with subsampled
// chroma. It draws in 4:4:4 here, and the pictures are converted afterwards, so
// that they have the size that the case names.
const pictures = (size: string, format: string, blur = "") =>
	`testsrc2=size=${size}:rate=25:duration=${FRAMES / 25},format=yuv444p${blur},format=${format}`;
const sides = (size: string) => {
	const [width = 0, height = 0] = size.split("x").map(Number);
	return { width, height };
};

/**
 * The ordinary method, with the options that the worker always gives it: two
 * inputs of one size, each in a format of its own, and the encode conformed to
 * the reference's size and rate.
 */
function ordinary(
	model: string,
	size: string,
	referenceFormat: string,
	encodeFormat = referenceFormat,
) {
	const { outcome, stderr } = run({
		model,
		distortedPath: pictures(size, encodeFormat, ",gblur=sigma=1.5"),
		referencePath: pictures(size, referenceFormat),
		scaleToReference: sides(size),
		fpsConform: 25,
	});
	const compared = { model, ...sides(size) };
	return {
		outcome,
		// What the worker says before the run, and after a run that failed.
		before: vmafSizeLimitMessage({
			...compared,
			chroma: vmafChromaLayout(referenceFormat),
		}),
		after: vmafSizeLimitFailureMessage(stderr, compared),
	};
}

/** The frame-index method: both inputs scaled to the canvas, the encode's size declared. */
function frameIndex(model: string, canvas: string, declared: string) {
	const { outcome, stderr } = run({
		model,
		measurementMethod: "FRAME_INDEX_BT709_10BIT",
		referenceFrameRate: "25/1",
		scaleToReference: sides(canvas),
		distortedOriginal: { ...sides(declared), bitdepth: 8 },
		distortedPath: pictures("320x180", "yuv420p", ",gblur=sigma=1"),
		referencePath: pictures("320x180", "yuv420p"),
	});
	const compared = { model, ...sides(canvas) };
	return {
		outcome,
		before: vmafSizeLimitMessage({
			...compared,
			chroma: "4:2:0",
			declaredEncode: sides(declared),
		}),
		after: vmafSizeLimitFailureMessage(stderr, compared),
	};
}

/**
 * Holds one case against what was expected of it: FFmpeg's outcome, that the
 * check before the run refuses it exactly when FFmpeg does not score it, and
 * that the sentence after a failed run is there exactly for SpEED's refusal.
 * Returns what differs, so that one test can list every case that does.
 */
function differences(
	name: string,
	expected: Outcome,
	seen: { outcome: string; before?: string; after?: string },
	check: "exact" | "unknown layout" = "exact",
): string[] {
	const found: string[] = [];
	if (seen.outcome !== expected)
		found.push(`${name}: expected "${expected}", FFmpeg: "${seen.outcome}"`);
	// With an unknown chroma layout the check refuses nothing that some layout
	// can score, so it is silent here whatever FFmpeg then does.
	const refusedBefore = check === "exact" && expected !== "scores";
	if ((seen.before !== undefined) !== refusedBefore)
		found.push(
			`${name}: the check before the run ${seen.before === undefined ? "is silent" : `says "${seen.before}"`}`,
		);
	if (
		(seen.after !== undefined) !==
		(expected === "SpEED refuses the pictures")
	)
		found.push(
			`${name}: the sentence after the run is ${seen.after === undefined ? "missing" : "there"}`,
		);
	return found;
}

describe.skipIf(!ready)("libvmaf's picture size limits (real ffmpeg)", () => {
	it("the image holds the VMAF v1 models that the limits are written for, each with the prescale that the limits use", () => {
		const bundled = readdirSync(modelDir)
			.filter((name) => /^vmaf_v1\..*\.json$/.test(name))
			.sort();
		expect(bundled).toEqual(
			[...VMAF_SPEED_CHROMA_PRESCALE.keys()].map((m) => `${m}.json`).sort(),
		);
		expect(Object.keys(SMALLEST_CHROMA_SIDE).sort()).toEqual(
			[...VMAF_SPEED_CHROMA_PRESCALE.keys()].sort(),
		);
		for (const [model, prescale] of VMAF_SPEED_CHROMA_PRESCALE) {
			const { model_dict: fields } = JSON.parse(
				readFileSync(join(modelDir, `${model}.json`), "utf8"),
			);
			// The two features that have a smallest picture.
			expect(fields.feature_names, model).toContain(
				"Cambi_feature_cambi_score",
			);
			const speed = fields.feature_names.indexOf(
				"Speed_chroma_feature_speed_chroma_uv_score",
			);
			expect(speed, model).toBeGreaterThanOrEqual(0);
			expect(fields.feature_opts_dicts[speed].speed_prescale ?? 1, model).toBe(
				prescale,
			);
		}
	});

	it("the ordinary method scores every model at SpEED's edge and crashes one pixel below it, in each chroma layout", () => {
		const found: string[] = [];
		for (const [model, side] of Object.entries(SMALLEST_CHROMA_SIDE)) {
			for (const [format, acrossWidth, acrossHeight] of [
				["yuv444p", 1, 1],
				["yuv422p", 2, 1],
				["yuv420p", 2, 2],
			] as const) {
				const width = side * acrossWidth;
				const height = side * acrossHeight;
				for (const [size, expected] of [
					[`400x${height}`, "scores"],
					[`400x${height - 1}`, "SpEED refuses the pictures"],
					[`${width}x400`, "scores"],
					[`${width - 1}x400`, "SpEED refuses the pictures"],
				] as const)
					found.push(
						...differences(
							`${model} ${format} ${size}`,
							expected,
							ordinary(model, size, format),
						),
					);
			}
		}
		expect(found).toEqual([]);
	}, 240_000);

	it("the ordinary method follows the chroma layout in every pixel format that libvmaf takes, and needs 216 pixels on one side", () => {
		const found: string[] = [];
		// 80 is the smallest chroma side for this model; the luma height that
		// gives it is 160 with 4:2:0 and 80 with the other two layouts.
		for (const depth of ["", "10le", "12le", "16le"])
			for (const [sampling, height] of [
				["420", 160],
				["422", 80],
				["444", 80],
			] as const) {
				const format = `yuv${sampling}p${depth}`;
				for (const [size, expected] of [
					[`400x${height}`, "scores"],
					[`400x${height - 1}`, "SpEED refuses the pictures"],
				] as const)
					found.push(
						...differences(
							`${format} ${size}`,
							expected,
							ordinary(V1, size, format),
						),
					);
			}
		// CAMBI: one side of the pictures must reach 216.
		for (const format of ["yuv420p", "yuv444p10le"])
			for (const [size, expected] of [
				["215x215", "CAMBI refuses the size"],
				["216x215", "scores"],
				["215x216", "scores"],
			] as const)
				found.push(
					...differences(
						`${format} ${size}`,
						expected,
						ordinary(V1, size, format),
					),
				);
		expect(found).toEqual([]);
	}, 120_000);

	it("the ordinary method compares in the reference's pixel format when libvmaf takes it, and in the encode's when it does not", () => {
		const found: string[] = [];
		// The worker conforms the encode to the reference with a scale filter,
		// whatever the two sizes are. That filter can give any format, so FFmpeg
		// gives the encode the reference's format and leaves the reference as it
		// is. 216x100: enough for 4:4:4 and 4:2:2 chroma, too small for 4:2:0.
		for (const [reference, encode, expected] of [
			["yuv444p", "yuv420p", "scores"],
			["yuv422p", "yuv420p", "scores"],
			["yuv420p", "yuv444p", "SpEED refuses the pictures"],
			["yuv420p10le", "yuv444p", "SpEED refuses the pictures"],
		] as const)
			found.push(
				...differences(
					`reference ${reference}, encode ${encode}`,
					expected,
					ordinary(V1, "216x100", reference, encode),
				),
			);
		// A reference in a format that libvmaf does not take is converted to the
		// encode's format, so its own layout says nothing: the check is silent
		// and a failed run names the limit.
		for (const [reference, encode, expected] of [
			["yuvj420p", "yuv444p", "scores"],
			["yuvj420p", "yuv420p", "SpEED refuses the pictures"],
			["nv12", "yuv444p", "scores"],
			["nv12", "yuv420p", "SpEED refuses the pictures"],
			["gray", "yuv422p", "scores"],
		] as const) {
			expect(vmafChromaLayout(reference)).toBeUndefined();
			found.push(
				...differences(
					`reference ${reference}, encode ${encode}`,
					expected,
					ordinary(V1, "216x100", reference, encode),
					"unknown layout",
				),
			);
		}
		expect(found).toEqual([]);
	}, 120_000);

	it("the frame-index method refuses a declared encode outside CAMBI's range or below 216 on both sides, and takes one that exceeds the pictures as the pictures", () => {
		const found: string[] = [];
		for (const [canvas, declared, expected] of [
			// CAMBI's range for a declared side: 144 to 7680.
			["640x480", "143x400", "CAMBI refuses its options"],
			["640x480", "144x400", "scores"],
			["640x480", "400x143", "CAMBI refuses its options"],
			["640x480", "400x144", "scores"],
			["640x480", "7681x4320", "CAMBI refuses its options"],
			["640x480", "7680x7681", "CAMBI refuses its options"],
			["640x480", "7680x4320", "scores"],
			// A declared size within the pictures needs 216 on one side.
			["640x480", "144x144", "CAMBI refuses the size"],
			["640x480", "215x215", "CAMBI refuses the size"],
			["640x480", "144x215", "CAMBI refuses the size"],
			["640x480", "216x144", "scores"],
			["640x480", "144x216", "scores"],
			// One that exceeds the pictures on a side counts as the pictures.
			["640x480", "641x150", "scores"],
			["640x480", "150x481", "scores"],
			["640x480", "641x100", "CAMBI refuses its options"],
			["1920x1080", "2000x1200", "scores"],
			["1920x1080", "144x144", "CAMBI refuses the size"],
			["200x200", "1920x1080", "CAMBI refuses the size"],
			["200x400", "1920x1080", "scores"],
			// Also one that is below 216 on both sides.
			["200x400", "210x150", "scores"],
			["400x200", "150x210", "scores"],
			["200x400", "150x215", "CAMBI refuses the size"],
			// The pictures themselves, in the 4:2:0 that this method compares in.
			["216x159", "216x159", "SpEED refuses the pictures"],
			["216x160", "216x160", "scores"],
			["159x216", "159x216", "SpEED refuses the pictures"],
			["160x216", "160x216", "scores"],
		] as const)
			found.push(
				...differences(
					`canvas ${canvas}, declared ${declared}`,
					expected,
					frameIndex(V1, canvas, declared),
				),
			);
		for (const [model, canvas, expected] of [
			["vmaf_v1.0.16_5d0h", "400x265", "SpEED refuses the pictures"],
			["vmaf_v1.0.16_5d0h", "400x266", "scores"],
			["vmaf_v1.0.16_3d0h_2160", "400x317", "SpEED refuses the pictures"],
			["vmaf_v1.0.16_3d0h_2160", "400x318", "scores"],
		] as const)
			found.push(
				...differences(
					`${model} canvas ${canvas}`,
					expected,
					frameIndex(model, canvas, canvas),
				),
			);
		expect(found).toEqual([]);
	}, 120_000);

	it("a model of the vmaf_v0.6.1 family scores the pictures that the v1 models refuse, as the sentences advise", () => {
		const found: string[] = [];
		for (const model of ["vmaf_v0.6.1", "vmaf_v0.6.1neg", "vmaf_4k_v0.6.1"]) {
			for (const size of ["215x215", "216x100", "64x36"])
				found.push(
					...differences(
						`${model} ${size}`,
						"scores",
						ordinary(model, size, "yuv420p"),
					),
				);
			// This family holds no CAMBI, so no size is declared to it.
			found.push(
				...differences(
					`${model} canvas 200x200, encode 100x100`,
					"scores",
					frameIndex(model, "200x200", "100x100"),
				),
			);
		}
		expect(found).toEqual([]);
	}, 120_000);
});
