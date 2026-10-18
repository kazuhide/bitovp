/**
 * Live (pseudo-live) VMAF acceptance proof (P4-PR6b). Runs INSIDE the pinned
 * worker image (bitovp-worker:latest) — that image bundles the static
 * libvmaf ffmpeg and tsx, so this exercises the REAL pipeline end-to-end, the
 * part PR6a's synthetic in-memory test could not:
 *
 *   1. Build a deterministic SOURCE clip (testsrc2, byte-exact per ffmpeg
 *      build) and a "captured" DISTORTED clip = the source looped ≥3× starting
 *      at a KNOWN frame offset (ffmpeg -stream_loop + a frame-accurate trim).
 *   2. Run the REAL ffmpeg `signalstats` SIGNATURE extraction (signatures.ts,
 *      through the real node process runner) on BOTH clips.
 *   3. Feed the engine (`alignLoopedSignatures`) and ASSERT:
 *        - recovered offset == the known offset (±1 frame),
 *        - confidence above the processor's low-confidence threshold,
 *        - loopMap has ≥3 entries (a ≥3-loop capture).
 *   4. Build the ALIGNED reference (source looped + trimmed to the offset) and
 *      run libvmaf(distorted, alignedReference) via the SAME buildVmafCommand
 *      the worker uses; ASSERT a HIGH VMAF (distorted ≈ source aligned → ~95+).
 *
 * NOT a CI gate (CI has no ffmpeg). Invoked by live-vmaf-acceptance.sh:
 *
 *   docker compose run --rm --entrypoint sh worker \
 *       /app/apps/worker/scripts/live-vmaf-acceptance.sh
 *
 * It reuses the SHIPPED modules (no re-implementation): the same signature
 * extraction, the same alignment engine, the same libvmaf argv builder + the
 * aligned-reference build the live processor runs. Numbers are reported so a
 * reviewer sees the observed offset, confidence, and VMAF.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVmafCommand, computePooled, parseVmafJson } from "@bitovp/core";
import { createNodeProcessRunner } from "../src/feeder/process-runner";
import { alignWithFallback } from "../src/vmaf/live-processor";
import { extractStats } from "../src/vmaf/signatures";

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const MODEL = process.env.VMAF_MODEL ?? "vmaf_v0.6.1";
const FPS = 30;
// The source clip length in frames (testsrc2 @ FPS for N seconds).
const SOURCE_SECONDS = 4;
const SOURCE_FRAMES = SOURCE_SECONDS * FPS; // 120
// The KNOWN offset we bake into the captured clip — the value the engine must
// recover. Chosen mid-period so it is unambiguous.
const KNOWN_OFFSET = 37;
// Captured window length: ≥3 full source loops so the loop map has ≥3 entries.
const WINDOW_FRAMES = SOURCE_FRAMES * 3 + 20; // ~3.16 loops
// Acceptance thresholds.
const OFFSET_TOLERANCE = 1; // ±1 frame (the documented engine accuracy)
const MIN_CONFIDENCE = 0.5; // the processor's LOW_CONFIDENCE_THRESHOLD
const MIN_VMAF = 90; // aligned distorted≈source → high VMAF

const runner = createNodeProcessRunner();

function log(msg: string): void {
	process.stdout.write(`[live-vmaf-accept] ${msg}\n`);
}

async function run(bin: string, argv: string[], label: string): Promise<void> {
	const res = await runner.run(bin, argv);
	if (res.code !== 0) {
		const tail = res.stderr.trim().split("\n").at(-1) ?? "no output";
		throw new Error(`${label} failed (code ${res.code}): ${tail}`);
	}
}

async function main(): Promise<void> {
	const work = await mkdtemp(join(tmpdir(), "live-vmaf-accept-"));
	const sourcePath = join(work, "source.mp4");
	const distortedPath = join(work, "captured.mp4");
	const alignedRefPath = join(work, "aligned.mp4");
	const vmafLog = join(work, "vmaf.json");
	try {
		// Verify the bundled ffmpeg has libvmaf.
		const ver = await runner.run(FFMPEG, ["-hide_banner", "-version"]);
		log(`ffmpeg: ${ver.stdout.split("\n")[0] ?? "?"}`);
		if (!ver.stdout.includes("--enable-libvmaf")) {
			throw new Error("this ffmpeg lacks --enable-libvmaf");
		}

		// --- 1. deterministic source + a looped capture at a KNOWN offset -------
		// testsrc2 is byte-deterministic per ffmpeg build. CRF 12 keeps it sharp
		// so signatures are discriminative.
		log(
			`generating source (testsrc2 ${SOURCE_SECONDS}s @ ${FPS}fps = ${SOURCE_FRAMES} frames)…`,
		);
		await run(
			FFMPEG,
			[
				"-hide_banner",
				"-nostdin",
				"-y",
				"-f",
				"lavfi",
				"-i",
				`testsrc2=size=640x360:rate=${FPS}:duration=${SOURCE_SECONDS}`,
				"-c:v",
				"libx264",
				"-threads",
				"1",
				"-crf",
				"12",
				"-pix_fmt",
				"yuv420p",
				sourcePath,
			],
			"source generation",
		);

		// The "captured" distorted clip = the source looped, dropping the first
		// KNOWN_OFFSET frames, keeping WINDOW_FRAMES — i.e. it STARTS at source
		// frame KNOWN_OFFSET and wraps ≥3 times. select='gte(n,offset)' counts
		// frames continuously across loops (the same trick the worker's
		// aligned-reference build uses). Re-encoded at a fixed bitrate so the
		// distorted side is a genuine encode (VMAF < 100 but high once aligned).
		const plays = Math.ceil((KNOWN_OFFSET + WINDOW_FRAMES) / SOURCE_FRAMES) + 1;
		log(
			`generating captured clip (offset=${KNOWN_OFFSET}, ${WINDOW_FRAMES} frames, ${plays} plays)…`,
		);
		await run(
			FFMPEG,
			[
				"-hide_banner",
				"-nostdin",
				"-y",
				"-stream_loop",
				String(plays - 1),
				"-i",
				sourcePath,
				"-vf",
				`fps=${FPS},select='gte(n\\,${KNOWN_OFFSET})',setpts=N/FRAME_RATE/TB`,
				"-frames:v",
				String(WINDOW_FRAMES),
				"-c:v",
				"libx264",
				"-threads",
				"1",
				"-b:v",
				"800k",
				"-maxrate",
				"800k",
				"-bufsize",
				"1600k",
				"-pix_fmt",
				"yuv420p",
				distortedPath,
			],
			"captured-clip generation",
		);

		// --- 2. REAL signature extraction on both clips (raw stats) -------------
		log("extracting source signature (ffmpeg signalstats)…");
		const sourceStats = await extractStats({
			runner,
			ffmpegPath: FFMPEG,
			path: sourcePath,
			options: { fps: FPS },
		});
		log("extracting captured (distorted) signature…");
		const distortedStats = await extractStats({
			runner,
			ffmpegPath: FFMPEG,
			path: distortedPath,
			options: { fps: FPS },
		});
		const distortedSig = { length: distortedStats.length };
		log(
			`signatures: source=${sourceStats.length} frames, distorted=${distortedStats.length} frames`,
		);

		// --- 3. align + assert offset/confidence/loopMap ------------------------
		// Same luma→enriched fallback the live processor uses (alignWithFallback).
		const { alignment, signatureMode } = alignWithFallback(
			sourceStats,
			distortedStats,
			{
				// : one 2 s segment grid, no holes (the harness source is CFR from t=0)
				segmentFrames: Math.round(2 * FPS),
				mask: new Array<boolean>(sourceStats.length).fill(false),
				includeThreshold: 0.5,
			},
		);
		const offsetErr = Math.min(
			Math.abs(alignment.offset - KNOWN_OFFSET),
			SOURCE_FRAMES - Math.abs(alignment.offset - KNOWN_OFFSET), // ring distance
		);
		log("──────────────────────────────────────────────");
		log(`signature mode    = ${signatureMode}`);
		log(`recovered offset  = ${alignment.offset} (known ${KNOWN_OFFSET})`);
		log(`offset error      = ${offsetErr} frame(s)`);
		log(`confidence        = ${alignment.confidence.toFixed(4)}`);
		log(`loopMap entries   = ${alignment.loopMap.length}`);
		log(
			`drift             = ${alignment.drift.detected ? `DETECTED (${alignment.drift.maxDriftFrames} frames)` : "none"}`,
		);

		if (offsetErr > OFFSET_TOLERANCE) {
			throw new Error(
				`FAIL: recovered offset ${alignment.offset} is more than ±${OFFSET_TOLERANCE} from known ${KNOWN_OFFSET}`,
			);
		}
		if (alignment.confidence < MIN_CONFIDENCE) {
			throw new Error(
				`FAIL: confidence ${alignment.confidence.toFixed(4)} below threshold ${MIN_CONFIDENCE}`,
			);
		}
		if (alignment.loopMap.length < 3) {
			throw new Error(
				`FAIL: loopMap has ${alignment.loopMap.length} entries, expected ≥3 (capture should span ≥3 loops)`,
			);
		}
		log("OK: offset ±1, confidence above threshold, ≥3 loop entries.");

		// --- 4. aligned reference + libvmaf, assert HIGH VMAF -------------------
		// Build the aligned reference exactly as the live processor does: loop
		// the source, drop the first `offset` frames, keep WINDOW_FRAMES.
		const refPlays =
			Math.ceil((alignment.offset + distortedSig.length) / SOURCE_FRAMES) + 1;
		log(`building aligned reference (offset=${alignment.offset})…`);
		await run(
			FFMPEG,
			[
				"-hide_banner",
				"-nostdin",
				"-y",
				"-stream_loop",
				String(refPlays - 1),
				"-i",
				sourcePath,
				"-vf",
				`fps=${FPS},select='gte(n\\,${alignment.offset})',setpts=N/FRAME_RATE/TB`,
				"-frames:v",
				String(distortedSig.length),
				"-an",
				alignedRefPath,
			],
			"aligned-reference build",
		);

		// The SAME argv builder the worker uses.
		const argv = buildVmafCommand({
			referencePath: alignedRefPath,
			distortedPath,
			model: MODEL,
			logPath: vmafLog,
		});
		log("running libvmaf(distorted, alignedReference)…");
		await run(FFMPEG, argv, "libvmaf scoring");
		const parsed = parseVmafJson(JSON.parse(await readFile(vmafLog, "utf8")));
		if (parsed.frames.length === 0) {
			throw new Error("FAIL: libvmaf produced no frame scores");
		}
		const pooled = computePooled(parsed.frames);
		log("──────────────────────────────────────────────");
		log(`mean VMAF         = ${pooled.mean.toFixed(3)}`);
		log(`harmonic mean     = ${pooled.harmonicMean.toFixed(3)}`);
		log(
			`min / max         = ${pooled.min.toFixed(2)} / ${pooled.max.toFixed(2)}`,
		);
		log(`scored frames     = ${parsed.frames.length}`);

		if (pooled.mean < MIN_VMAF) {
			throw new Error(
				`FAIL: mean VMAF ${pooled.mean.toFixed(3)} below ${MIN_VMAF} — the aligned reference does not match the captured clip (alignment or build is wrong)`,
			);
		}

		log("");
		log(
			`PASS — offset ${alignment.offset}≈${KNOWN_OFFSET} (±${OFFSET_TOLERANCE}), confidence ${alignment.confidence.toFixed(3)}, ${alignment.loopMap.length} loops, mean VMAF ${pooled.mean.toFixed(2)}. Real ffmpeg signature extraction + PR6a engine + libvmaf validated end-to-end.`,
		);
	} finally {
		await rm(work, { recursive: true, force: true }).catch(() => {});
	}
}

main().catch((err) => {
	process.stderr.write(
		`[live-vmaf-accept] ${err instanceof Error ? err.message : String(err)}\n`,
	);
	process.exit(1);
});
