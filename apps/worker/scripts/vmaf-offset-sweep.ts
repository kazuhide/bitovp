/**
 * Is a low VMAF score a bad encode, or a misaligned comparison?
 *
 * The VOD scorer compares frame N of the QC mirror with frame N of the source
 * and applies no temporal alignment — correct for a straight transcode, and
 * silently wrong by exactly any lead-in difference. A one-frame offset on
 * moving content does not lower a score gently; it makes the distribution
 * *bimodal*, because static frames still match and moving ones collapse to
 * zero. `vmaf-only-h264` reports exactly that shape: mean 23, p50 14, p25 0,
 * harmonic mean 0, max 78.
 *
 * So sweep the offset and look at the curve. A jump at some non-zero offset
 * means misalignment. A flat curve means the encode really is that bad and the
 * scorer was right all along — which is just as useful an answer.
 *
 * Usage (inside the worker container: needs ffmpeg and the vault):
 *   pnpm --filter @bitovp/worker exec tsx scripts/vmaf-offset-sweep.ts \
 *     --job <vmafJobId> [--offsets -3,-2,-1,0,1,2,3] [--model vmaf_v0.6.1]
 *
 * Read-only: downloads both sides to a temp dir, scores, prints a table, and
 * deletes them. Writes no database row.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alignLinearSignatures, cipherFromEnv } from "@bitovp/core";
import { createCredentialStore, createPrismaClient } from "@bitovp/db";
import { createNodeProcessRunner } from "../src/feeder/process-runner";
import { defaultVmafDownload } from "../src/vmaf/download";
import { extractSignature } from "../src/vmaf/signatures";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
	const at = argv.indexOf(`--${name}`);
	return at >= 0 ? argv[at + 1] : undefined;
};

const jobId = flag("job");
if (!jobId) {
	console.error("--job <vmafJobId> is required");
	process.exit(2);
}
const offsets = (flag("offsets") ?? "-3,-2,-1,0,1,2,3")
	.split(",")
	.map((n) => Number(n.trim()))
	.filter((n) => Number.isFinite(n));
const model = flag("model") ?? "vmaf_v0.6.1";
const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
const ffprobe = process.env.FFPROBE_PATH ?? "ffprobe";
const modelDir = process.env.VMAF_MODEL_DIR;
const runner = createNodeProcessRunner();

/** `model=path=` when the file is bundled, else the built-in `model=version=`. */
const modelSpec = modelDir
	? `model=path=${join(modelDir, `${model}.json`)}`
	: `model=version=${model}`;

const prisma = createPrismaClient(process.env.DATABASE_URL);
const work = await mkdtemp(join(tmpdir(), "vmaf-sweep-"));
try {
	const job = await prisma.vmafJob.findUnique({
		where: { id: jobId },
		select: {
			model: true,
			encodingJob: { select: { plan: true } },
		},
	});
	if (!job?.encodingJob) {
		throw new Error(`no vmaf job ${jobId}`);
	}
	const plan = job.encodingJob.plan as {
		inputs: { key: string; bucket?: string; credentialId: string }[];
		outputs: { key: string; bucket?: string; credentialId: string }[];
		ingest: { inputKey: string; inputPath: string }[];
		muxings: { destination?: { path?: string } }[];
		renditions: { key: string }[];
	};

	const credentials = createCredentialStore(prisma, cipherFromEnv());
	/** Same shape the worker's own `resolveCredential` builds (index.ts:81). */
	const resolve = async (id: string) => {
		const credential = await credentials.get(id);
		if (!credential) {
			throw new Error(`credential ${id} no longer exists`);
		}
		return {
			provider: credential.provider,
			config: (credential.config ?? {}) as Record<string, unknown>,
			secret: JSON.parse(await credentials.revealSecret(id)) as Record<
				string,
				string
			>,
		};
	};

	const ingest = plan.ingest[0];
	const input = plan.inputs.find((i) => i.key === ingest?.inputKey);
	if (!ingest || !input?.bucket) {
		throw new Error(
			"plan has no bucket-backed first input to use as reference",
		);
	}
	const refPath = join(work, "ref.mov");
	await defaultVmafDownload({
		credential: await resolve(input.credentialId),
		bucket: input.bucket,
		key: ingest.inputPath,
		destPath: refPath,
		label: "reference",
	});

	/**
	 * The mirror path the compiler derives: `<muxing dir>/qc/<renditionKey>.mp4`.
	 * Recomputed here rather than read from the row, because `VmafResult` stores
	 * only `renditionRef` and `pooled` — the key is not persisted.
	 */
	const distortedKey = flag("distorted-key");
	const output = plan.outputs[0];
	if (!distortedKey || !output?.bucket) {
		throw new Error(
			"--distorted-key <qc mirror key> is required (VmafResult does not store it)",
		);
	}
	const disPath = join(work, "dis.mp4");
	await defaultVmafDownload({
		credential: await resolve(output.credentialId),
		bucket: output.bucket,
		key: distortedKey,
		destPath: disPath,
		label: "distorted",
	});

	const probe = async (path: string) => {
		const res = await runner.run(ffprobe, [
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-count_frames",
			"-show_entries",
			"stream=width,height,r_frame_rate,nb_read_frames",
			"-of",
			"json",
			path,
		]);
		return JSON.parse(res.stdout).streams[0] as {
			width: number;
			height: number;
			r_frame_rate: string;
			nb_read_frames: string;
		};
	};
	const conformChain = (g: {
		width: number;
		height: number;
		r_frame_rate: string;
	}) => `scale=${g.width}:${g.height}:flags=bicubic,fps=${g.r_frame_rate}`;
	const ref = await probe(refPath);
	const dis = await probe(disPath);
	console.log(
		`reference : ${ref.width}x${ref.height} @${ref.r_frame_rate} ${ref.nb_read_frames} frames`,
	);
	console.log(
		`distorted : ${dis.width}x${dis.height} @${dis.r_frame_rate} ${dis.nb_read_frames} frames`,
	);
	console.log(
		`model     : ${model}${modelDir ? " (path=)" : " (version=)"} — job used ${job.model}`,
	);
	console.log("");

	/**
	 * The SIGNATURE view of the same question, so the aligner's own input sits
	 * next to the VMAF curve. If VMAF jumps at +1 but the signature distance does
	 * not, the aligner is being asked to see something its signature cannot —
	 * which is a different fix from a wrong threshold.
	 */
	const fps =
		Number(String(ref.r_frame_rate).split("/")[0]) /
		Number(String(ref.r_frame_rate).split("/")[1] ?? 1);
	for (const [label, options] of [
		["luma", { fps, frames: 240 }],
		["luma+ydif", { fps, frames: 240, enrich: true }],
	] as const) {
		const [refSig, disSig] = await Promise.all([
			extractSignature({ runner, ffmpegPath: ffmpeg, path: refPath, options }),
			extractSignature({ runner, ffmpegPath: ffmpeg, path: disPath, options }),
		]);
		const verdict = alignLinearSignatures(refSig, disSig);
		const at = (o: number): number => {
			const refFrom = o > 0 ? o : 0;
			const disFrom = o < 0 ? -o : 0;
			const n = Math.min(refSig.length - refFrom, disSig.length - disFrom);
			let sum = 0;
			for (let i = 0; i < n; i += 1) {
				sum += Math.abs(
					(refSig[refFrom + i] ?? 0) - (disSig[disFrom + i] ?? 0),
				);
			}
			return sum / (n || 1);
		};
		console.log(
			`signature ${label.padEnd(9)} (${refSig.length}/${disSig.length} frames) → ` +
				`offset ${verdict.offset} confident=${verdict.confident} ` +
				`best=${verdict.distance.toFixed(3)} runnerUp=${verdict.runnerUp.toFixed(3)}`,
		);
		console.log(
			`  distances  ${offsets.map((o) => `${o}:${at(o).toFixed(3)}`).join("  ")}`,
		);
	}
	console.log("");

	/**
	 * TIMESTAMPS, not frame counts.
	 *
	 * The signature (frame-indexed) says the clips are aligned at 0, while VMAF
	 * (which pairs frames through ffmpeg's framesync, i.e. by PTS) says +1. Both
	 * cannot be about frame order. `setpts=N/FRAME_RATE/TB` REBASES timestamps to
	 * a regular cadence from zero — so if that alone recovers the score, the
	 * defect is a PTS offset (a .mov edit list / non-zero first PTS) and dropping
	 * frames was only fixing it by accident.
	 */
	{
		const logPath = join(work, "retime.json");
		const lavfi =
			`[0:v]${conformChain(ref)},setpts=N/FRAME_RATE/TB[d];` +
			`[1:v]setpts=N/FRAME_RATE/TB[r];` +
			`[d][r]libvmaf=${modelSpec}:log_path=${logPath}:log_fmt=json`;
		const run = await runner.run(ffmpeg, [
			"-hide_banner",
			"-nostdin",
			"-i",
			disPath,
			"-i",
			refPath,
			"-lavfi",
			lavfi,
			"-f",
			"null",
			"-",
		]);
		if (run.code !== 0) {
			console.log(
				`retime    : FAILED — ${run.stderr.trim().split("\n").slice(-2).join(" | ").slice(0, 170)}`,
			);
		} else {
			const parsed = JSON.parse(await readFile(logPath, "utf8")) as {
				frames?: { metrics: Record<string, number> }[];
			};
			const scores = (parsed.frames ?? [])
				.map((f) => f.metrics.vmaf)
				.filter((n): n is number => typeof n === "number");
			const mean = scores.reduce((a, b) => a + b, 0) / (scores.length || 1);
			const sorted = [...scores].sort((a, b) => a - b);
			console.log(
				`retime  0 : mean ${mean.toFixed(2).padStart(6)}` +
					`  p50 ${(sorted[Math.floor(sorted.length / 2)] ?? 0).toFixed(2).padStart(6)}` +
					`  frames ${String(scores.length).padStart(4)}` +
					`  near-zero ${String(scores.filter((s) => s < 1).length).padStart(4)}` +
					"   ← both sides PTS-rebased, no frames dropped",
			);
		}
	}

	for (const offset of offsets) {
		const logPath = join(work, `o${offset}.json`);
		/**
		 * `select` + `setpts`, not `-ss`: a seek lands on a keyframe and would
		 * quantise the very thing being measured. A positive offset drops leading
		 * REFERENCE frames (the reference starts later than the distorted);
		 * negative drops leading distorted frames.
		 */
		const drop = (n: number) =>
			`select='gte(n\\,${n})',setpts=N/FRAME_RATE/TB,`;
		const conform = conformChain(ref);
		/**
		 * PAD ORDER MATTERS and the first version of this script had it backwards.
		 * ffmpeg's libvmaf takes the DISTORTED as its first input and the reference
		 * as its second — `command.ts` says so and the product builds
		 * `[dist][1:v]libvmaf`. Swapped, this script scored 31.66 at offset 0 where
		 * the product scored 23.08, and produced a +1 "jump" that was an artefact
		 * of comparing the pristine source *against* the upscaled encode.
		 */
		const lavfi =
			offset === 0
				? `[0:v]${conform}[d];[d][1:v]libvmaf=${modelSpec}:log_path=${logPath}:log_fmt=json`
				: offset > 0
					? `[0:v]${conform}[d];[1:v]${drop(offset)}null[r];[d][r]libvmaf=${modelSpec}:log_path=${logPath}:log_fmt=json`
					: `[0:v]${conform},${drop(-offset)}null[d];[d][1:v]libvmaf=${modelSpec}:log_path=${logPath}:log_fmt=json`;

		const run = await runner.run(ffmpeg, [
			"-hide_banner",
			"-nostdin",
			"-i",
			disPath,
			"-i",
			refPath,
			"-lavfi",
			lavfi,
			"-f",
			"null",
			"-",
		]);
		if (run.code !== 0) {
			const tail = run.stderr.trim().split("\n").slice(-2).join(" | ");
			console.log(
				`offset ${String(offset).padStart(3)} : FAILED — ${tail.slice(0, 170)}`,
			);
			continue;
		}
		const parsed = JSON.parse(await readFile(logPath, "utf8")) as {
			frames?: { metrics: Record<string, number> }[];
		};
		const scores = (parsed.frames ?? [])
			.map((f) => f.metrics.vmaf)
			.filter((n): n is number => typeof n === "number");
		const mean = scores.reduce((a, b) => a + b, 0) / (scores.length || 1);
		const sorted = [...scores].sort((a, b) => a - b);
		console.log(
			`offset ${String(offset).padStart(3)} : mean ${mean.toFixed(2).padStart(6)}` +
				`  p50 ${(sorted[Math.floor(sorted.length / 2)] ?? 0).toFixed(2).padStart(6)}` +
				`  frames ${String(scores.length).padStart(4)}` +
				`  near-zero ${String(scores.filter((s) => s < 1).length).padStart(4)}`,
		);
	}
} finally {
	await rm(work, { recursive: true, force: true }).catch(() => {});
	await prisma.$disconnect();
}
