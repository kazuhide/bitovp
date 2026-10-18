/**
 * Score one reference/distorted pair with EVERY bundled VMAF model, through the
 * product's own command builder.
 *
 * Why this exists: the VOD wizard's model dropdown offered seven models and **five of
 * them had never produced a score** — only `vmaf_v0.6.1` (the schema default, 11
 * finished jobs since 2026-06-23) and `vmaf_v1.0.16_3d0h` had. A dropdown entry that
 * names a model libvmaf cannot load is worse than an absent one: the operator picks
 * it, the encode runs for minutes, and the QC job fails at the very end.
 *
 * It builds each argv with core's `buildVmafCommand` rather than hand-writing an
 * ffmpeg line, so a failure here is the product failing. The synthetic pair is
 * generated deterministically (no network, no bucket, no Bitmovin) so the matrix
 * is repeatable and cheap; a real encode is a separate, and much slower, check.
 *
 * Usage, inside the worker container (it has ffmpeg+libvmaf and VMAF_MODEL_DIR):
 *   docker compose exec -w /app/apps/worker worker pnpm tsx \
 *     scripts/vmaf-model-matrix.ts
 *   docker compose exec -w /app/apps/worker worker pnpm tsx \
 *     scripts/vmaf-model-matrix.ts --reference /path/ref.mp4 --distorted /path/dis.mp4
 *
 * `-w /app/apps/worker` is required, not decoration: the container's WORKDIR is the
 * workspace root, where `tsx` does not resolve, so the documented form without it
 * fails with `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL` (review ran it verbatim). And this
 * file is not in the image — `docker compose cp apps/worker/scripts/… worker:/app/…`
 * it in first, or rebuild.
 *
 * Options:
 *   --reference, --distorted   score a real pair instead of the synthetic one
 *   --seconds N                synthetic clip length (default 5)
 *   --distorted-bitrate B      synthetic distorted bitrate (default 120k) — vary it
 *                              to see how much of the model spread is content
 *   --model-dir DIR            override VMAF_MODEL_DIR
 *   --json PATH                also write the raw table as JSON
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVmafCommand, VMAF_SCORING_VERSION } from "@bitovp/core";

type Row = {
	model: string;
	via: "version" | "path";
	ok: boolean;
	mean?: number;
	min?: number;
	harmonic?: number;
	frames?: number;
	seconds?: number;
	error?: string;
};

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? undefined : process.argv[i + 1];
}

function run(
	bin: string,
	args: string[],
): Promise<{ code: number; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
	});
}

/** Same, but keeps stdout — `ffprobe` answers there. */
function runCapturing(
	bin: string,
	args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
	});
}

/**
 * A pair with a real quality gap, and — deliberately — a non-zero start PTS on
 * the reference. That is the exact shape that produced the 3.6x understatement
 * this project spent a night diagnosing (libvmaf pairs frames through framesync,
 * i.e. by PTS), so the matrix runs against material that would expose a
 * regression of it rather than material chosen to look good.
 */
async function synthesize(dir: string, seconds: number, bitrate: string) {
	const reference = join(dir, "reference.mp4");
	const distorted = join(dir, "distorted.mp4");
	const common = [
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		`testsrc2=size=640x360:rate=30:duration=${seconds}`,
	];
	const ref = await run("ffmpeg", [
		...common,
		"-c:v",
		"libx264",
		"-crf",
		"14",
		"-pix_fmt",
		"yuv420p",
		"-output_ts_offset",
		"1.5",
		reference,
	]);
	if (ref.code !== 0) {
		throw new Error(`reference encode failed: ${ref.stderr.slice(0, 400)}`);
	}
	const dis = await run("ffmpeg", [
		...common,
		"-c:v",
		"libx264",
		// SINGLE-THREADED, because the claim below is "repeatable" and without this it
		// is not: x264's threaded lookahead makes the ABR encode byte-different every
		// run, so the same command produced means of 83.01 / 83.09 / 82.99 (review
		// measured it, and md5-identical output with this flag). The reference at
		// `-crf 14` was already stable; only the ABR side drifted. The digits quoted in
		// shipped UI copy have to be reproducible by whoever re-runs this.
		"-threads",
		"1",
		"-b:v",
		bitrate,
		"-maxrate",
		bitrate,
		"-bufsize",
		`${Number.parseInt(bitrate, 10) * 2}k`,
		"-vf",
		"scale=320:180",
		"-pix_fmt",
		"yuv420p",
		distorted,
	]);
	if (dis.code !== 0) {
		throw new Error(`distorted encode failed: ${dis.stderr.slice(0, 400)}`);
	}
	return { reference, distorted };
}

type Geometry = { width: number; height: number; fps?: number };

/**
 * The reference's real geometry, so a supplied pair works. libvmaf requires both
 * inputs at identical dimensions, and the distorted side is conformed TO the
 * reference — exactly what the product's own processor does.
 */
async function probeGeometry(path: string): Promise<Geometry> {
	const { code, stdout, stderr } = await runCapturing("ffprobe", [
		"-v",
		"error",
		"-select_streams",
		"v:0",
		"-show_entries",
		"stream=width,height,r_frame_rate",
		"-of",
		"default=nw=1:nk=1",
		path,
	]);
	if (code !== 0) {
		throw new Error(`ffprobe failed on ${path}: ${stderr.slice(0, 300)}`);
	}
	const [w, h, rate] = stdout.trim().split("\n");
	const [num, den] = (rate ?? "").split("/").map(Number);
	const fps =
		num !== undefined && den !== undefined && den !== 0 ? num / den : undefined;
	const width = Number(w);
	const height = Number(h);
	if (!Number.isFinite(width) || !Number.isFinite(height)) {
		throw new Error(`ffprobe gave no dimensions for ${path}: ${stdout}`);
	}
	return { width, height, ...(fps !== undefined ? { fps } : {}) };
}

/**
 * The line that says WHY, not the last two lines.
 *
 * Tailing stderr reported ffmpeg's progress line plus "Conversion failed!", so a
 * geometry mismatch surfaced as `frame= 0 fps=0.0 … / Conversion failed!` for all
 * fourteen models — a false-alarm channel with no diagnosable cause, in a script
 * whose non-zero exit is meant to gate an image change (review finding).
 */
function diagnose(stderr: string): string {
	const lines = stderr
		.trim()
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	const meaningful = lines.filter(
		(l) =>
			/libvmaf|model|Error|Invalid|must match|No such file|Permission/i.test(
				l,
			) && !/^frame=/.test(l),
	);
	const picked = (meaningful.length > 0 ? meaningful : lines).slice(-2);
	return picked.join(" / ").slice(0, 220);
}

function bundledModels(modelDir: string): string[] {
	return readdirSync(modelDir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => f.replace(/\.json$/, ""))
		.sort();
}

/**
 * The v0.6.1 family is compiled into libvmaf, so it is reachable BOTH ways; the
 * `float_` variants have no built-in name and are file-only.
 *
 * These three rows are scored via `version=` as a **cross-check of the two selectors**,
 * not because it is what the product does. An earlier version of this comment claimed
 * the latter and was false: `processor.ts` calls `resolveModelPath` unconditionally for
 * every model and the image bundles `vmaf_v0.6.1.json`, so the product takes
 * `model=path=` for this family too (review finding). Measured consequence: none —
 * `version=` and `path=` produced byte-identical pooled metrics for `vmaf_v0.6.1`
 * (min 76.237778 / mean 79.672067 both ways), which is why keeping three rows on the
 * other selector is worth more as a comparison than as a duplicate.
 */
function viaFor(model: string): "version" | "path" {
	return /^vmaf_(v0\.6\.1(neg)?|4k_v0\.6\.1)$/.test(model) ? "version" : "path";
}

async function score(
	model: string,
	modelDir: string,
	reference: string,
	distorted: string,
	dir: string,
	geometry: Geometry,
): Promise<Row> {
	const via = viaFor(model);
	const logPath = join(dir, `${model}.json`);
	const argv = buildVmafCommand({
		referencePath: reference,
		distortedPath: distorted,
		model,
		...(via === "path" ? { modelPath: join(modelDir, `${model}.json`) } : {}),
		logPath,
		// The REFERENCE's real geometry, probed — not the synthetic pair's. Hardcoding
		// 640x360@30 made `--reference/--distorted` unusable on anything else: a
		// 1080p@24 pair, i.e. the shape this product actually emits, failed 14/14 with
		// libvmaf's "input width must match" (review measured it). The product does the
		// same thing — `processor.ts` passes the probed `geometry`.
		scaleToReference: { width: geometry.width, height: geometry.height },
		...(geometry.fps !== undefined ? { fpsConform: geometry.fps } : {}),
	});
	const started = process.hrtime.bigint();
	const { code, stderr } = await run("ffmpeg", argv);
	const seconds = Number(process.hrtime.bigint() - started) / 1e9;
	if (code !== 0) {
		return {
			model,
			via,
			ok: false,
			seconds,
			error: diagnose(stderr),
		};
	}
	const report = JSON.parse(readFileSync(logPath, "utf8")) as {
		pooled_metrics?: {
			vmaf?: { mean?: number; min?: number; harmonic_mean?: number };
		};
		frames?: unknown[];
	};
	const pooled = report.pooled_metrics?.vmaf;
	return {
		model,
		via,
		ok: true,
		seconds,
		...(pooled?.mean !== undefined ? { mean: pooled.mean } : {}),
		...(pooled?.min !== undefined ? { min: pooled.min } : {}),
		...(pooled?.harmonic_mean !== undefined
			? { harmonic: pooled.harmonic_mean }
			: {}),
		frames: report.frames?.length ?? 0,
	};
}

async function main() {
	const modelDir = arg("model-dir") ?? process.env.VMAF_MODEL_DIR;
	if (!modelDir) {
		throw new Error(
			"VMAF_MODEL_DIR is unset and --model-dir was not given. Run this inside the worker container.",
		);
	}
	const dir = mkdtempSync(join(tmpdir(), "vmaf-matrix-"));
	try {
		const suppliedRef = arg("reference");
		const suppliedDis = arg("distorted");
		let reference: string;
		let distorted: string;
		if (suppliedRef && suppliedDis) {
			reference = suppliedRef;
			distorted = suppliedDis;
			console.log(`pair: ${reference} vs ${distorted} (supplied)`);
		} else {
			const seconds = Number(arg("seconds") ?? 5);
			const bitrate = arg("distorted-bitrate") ?? "120k";
			({ reference, distorted } = await synthesize(dir, seconds, bitrate));
			console.log(
				`pair: synthetic ${seconds}s testsrc2 640x360@30 crf14 (ref, +1.5s start PTS) vs ${bitrate} 320x180 (dis)`,
			);
		}
		// Probe the reference once: every row conforms the distorted side to it.
		const geometry = await probeGeometry(reference);
		console.log(
			`reference geometry: ${geometry.width}x${geometry.height}${geometry.fps !== undefined ? `@${geometry.fps.toFixed(3).replace(/\.?0+$/, "")}` : ""}`,
		);
		const models = bundledModels(modelDir);
		console.log(
			`models: ${models.length} bundled in ${modelDir} · scoring version ${VMAF_SCORING_VERSION}\n`,
		);
		const rows: Row[] = [];
		for (const model of models) {
			const row = await score(
				model,
				modelDir,
				reference,
				distorted,
				dir,
				geometry,
			);
			rows.push(row);
			console.log(
				row.ok
					? `  ok    ${model.padEnd(30)} mean ${row.mean?.toFixed(2).padStart(6)}  min ${row.min?.toFixed(2).padStart(6)}  harm ${row.harmonic?.toFixed(2).padStart(6)}  ${row.frames} frames  ${row.seconds?.toFixed(1)}s  (${row.via}=)`
					: `  FAIL  ${model.padEnd(30)} ${row.error}`,
			);
		}
		console.log("\n| model | via | mean | min | harmonic | frames | ok |");
		console.log("|---|---|---|---|---|---|---|");
		for (const r of rows) {
			console.log(
				`| \`${r.model}\` | ${r.via}= | ${r.mean?.toFixed(2) ?? "—"} | ${r.min?.toFixed(2) ?? "—"} | ${r.harmonic?.toFixed(2) ?? "—"} | ${r.frames ?? "—"} | ${r.ok ? "yes" : `**no** — ${r.error}`} |`,
			);
		}
		const failed = rows.filter((r) => !r.ok);
		console.log(
			`\n${rows.length - failed.length}/${rows.length} models scored${failed.length ? `; FAILED: ${failed.map((r) => r.model).join(", ")}` : ""}`,
		);
		const jsonOut = arg("json");
		if (jsonOut) {
			const { writeFileSync } = await import("node:fs");
			writeFileSync(jsonOut, `${JSON.stringify(rows, null, 2)}\n`);
			console.log(`wrote ${jsonOut}`);
		}
		process.exitCode = failed.length === 0 ? 0 : 1;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exitCode = 1;
});
