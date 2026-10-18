/**
 * ARTEFACT verification for a finished encoding job.
 *
 * Every other check in this repo stops at the boundary of our own code: 3,234 unit
 * tests over fixtures, 73 golden plan→ops pins, an argv proof against a synthetic clip.
 * None of them looks at a file the encoder actually wrote, which is how a VMAF report
 * of mean 16.77 with half its frames at zero shipped as "FINISHED", how the HLS manifest
 * step turned out to have never once succeeded here, and how the worker ran a six-week-old
 * image unnoticed. This closes that gap for one job: it fetches what the encoder PUT IN
 * THE BUCKET and asserts the artefacts match what the plan asked for.
 *
 * Read-only against storage. Downloads to a temp dir and deletes it.
 *
 * Run inside the worker image, which has ffprobe/ffmpeg and the linux Prisma client:
 *
 *   docker compose run --rm --entrypoint sh worker -c \
 *     'pnpm --filter @bitovp/worker exec tsx scripts/verify-encoding-output.ts <jobId>'
 *
 * Exit code is the number of failed assertions, so a caller can gate on it.
 */

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { cipherFromEnv, encodingPlanSchema } from "@bitovp/core";
import { createCredentialStore, createPrismaClient } from "@bitovp/db";
import {
	createBrowserForCredential,
	type ObjectStorageBrowser,
} from "@bitovp/storage";

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const record = (name: string, ok: boolean, detail: string) => {
	checks.push({ name, ok, detail });
	console.log(
		`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
	);
};

function run(
	cmd: string,
	args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => {
			stdout += String(d);
		});
		child.stderr.on("data", (d) => {
			stderr += String(d);
		});
		child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
	});
}

type Probe = {
	width?: number;
	height?: number;
	rFrameRate?: string;
	avgFrameRate?: string;
	nbFrames?: string;
	duration?: string;
	codec?: string;
	audioChannels?: number;
	audioCodec?: string;
	bitRate?: string;
};

async function probe(path: string): Promise<Probe> {
	const r = await run("ffprobe", [
		"-v",
		"error",
		"-print_format",
		"json",
		"-show_streams",
		"-show_format",
		path,
	]);
	if (r.code !== 0) {
		throw new Error(
			`ffprobe failed on ${path}: ${r.stderr.trim().slice(-200)}`,
		);
	}
	const parsed = JSON.parse(r.stdout) as {
		streams?: Record<string, unknown>[];
		format?: Record<string, unknown>;
	};
	const streams = parsed.streams ?? [];
	const v = streams.find((s) => s.codec_type === "video");
	const a = streams.find((s) => s.codec_type === "audio");
	return {
		width: v?.width as number | undefined,
		height: v?.height as number | undefined,
		rFrameRate: v?.r_frame_rate as string | undefined,
		avgFrameRate: v?.avg_frame_rate as string | undefined,
		nbFrames: v?.nb_frames as string | undefined,
		duration: (parsed.format?.duration ?? v?.duration) as string | undefined,
		codec: v?.codec_name as string | undefined,
		audioChannels: a?.channels as number | undefined,
		audioCodec: a?.codec_name as string | undefined,
		bitRate: parsed.format?.bit_rate as string | undefined,
	};
}

const rate = (raw: string | undefined): number | undefined => {
	if (!raw || raw === "0/0") {
		return undefined;
	}
	const [n, d] = raw.includes("/") ? raw.split("/") : [raw, "1"];
	const num = Number(n);
	const den = Number(d);
	return Number.isFinite(num) && Number.isFinite(den) && den !== 0 && num !== 0
		? num / den
		: undefined;
};

/** `getObject` yields a Node stream (it is optional on the interface — S3/GCS/Azure
 * implement it; a driver without it cannot be verified this way and says so). */
async function fetchTo(
	browser: ObjectStorageBrowser,
	bucket: string,
	key: string,
	destPath: string,
): Promise<void> {
	if (!browser.getObject) {
		throw new Error("this storage driver cannot stream objects (no getObject)");
	}
	const stream = await browser.getObject({ bucket, key });
	await pipeline(stream, createWriteStream(destPath));
}

async function main(): Promise<void> {
	const jobIdPrefix = process.argv[2];
	if (!jobIdPrefix) {
		console.error(
			"usage: verify-encoding-output.ts <encodingJobId (or prefix)>",
		);
		process.exit(2);
	}

	const prisma = createPrismaClient(process.env.DATABASE_URL);
	const credentials = createCredentialStore(prisma, cipherFromEnv());

	const rows = await prisma.encodingJob.findMany({
		select: { id: true, name: true, status: true, plan: true },
		orderBy: { createdAt: "desc" },
		take: 50,
	});
	const job = rows.find((r) => r.id.startsWith(jobIdPrefix));
	if (!job) {
		console.error(`no EncodingJob whose id starts with ${jobIdPrefix}`);
		process.exit(2);
	}
	console.log(`job ${job.id}  "${job.name}"  status=${job.status}\n`);

	const plan = encodingPlanSchema.parse(job.plan);
	const dir = await mkdtemp(join(tmpdir(), "verify-"));

	try {
		// ---- reference (the source the encoder read) -------------------------------
		const ingest = plan.ingest?.[0];
		const found = plan.inputs.find((i) => i.key === ingest?.inputKey);
		if (!ingest || !found) {
			record("plan names a source input", false, "no ingest/input pair");
			return;
		}
		/**
		 * Narrowed once, here. The input union includes HTTPS/HTTP sources, which carry
		 * no `credentialId` and no `bucket` — this script downloads the reference
		 * through a storage browser, so it only supports the bucket-shaped kinds. That
		 * was implicit until `scripts/` entered the typecheck (review finding: the whole
		 * directory was excluded, so a planted `referencePath: 42` compiled clean).
		 */
		if (!("credentialId" in found) || !("bucket" in found)) {
			record(
				"source input is bucket-shaped",
				false,
				`kind ${found.kind} has no credential/bucket — this script downloads through a storage browser`,
			);
			return;
		}
		const input = found;
		const inputCred = await credentials.get(input.credentialId);
		if (!inputCred) {
			record("input credential exists", false, input.credentialId);
			return;
		}
		const inputBrowser = createBrowserForCredential({
			provider: inputCred.provider,
			config: (inputCred.config ?? {}) as Record<string, unknown>,
			secret: JSON.parse(
				await credentials.revealSecret(input.credentialId),
			) as Record<string, string>,
		});
		const refPath = join(dir, "reference");
		await fetchTo(inputBrowser, input.bucket, ingest.inputPath, refPath);
		const refProbe = await probe(refPath);
		record(
			"reference downloads and probes",
			refProbe.width !== undefined,
			`${refProbe.width}x${refProbe.height} ${refProbe.codec} ` +
				`r_frame_rate=${refProbe.rFrameRate} avg_frame_rate=${refProbe.avgFrameRate} ` +
				`nb_frames=${refProbe.nbFrames} duration=${refProbe.duration}`,
		);
		// The VOD VMAF runner conforms the DISTORTED side to the reference using
		// r_frame_rate, preferring it over avg_frame_rate. When those disagree the
		// conform target is wrong and the two sides desync.
		const rFps = rate(refProbe.rFrameRate);
		const avgFps = rate(refProbe.avgFrameRate);
		record(
			"reference r_frame_rate agrees with avg_frame_rate",
			rFps !== undefined && avgFps !== undefined
				? Math.abs(rFps - avgFps) < 0.01
				: false,
			`r=${rFps?.toFixed(4)} avg=${avgFps?.toFixed(4)}`,
		);

		// ---- outputs (what the encoder wrote) --------------------------------------
		const firstOutput = plan.outputs[0];
		if (!firstOutput) {
			record("plan names an output", false, "none");
			return;
		}
		// Same narrowing as the input above: SFTP/HTTPS outputs have no bucket, and this
		// script lists objects through a storage browser.
		if (!("bucket" in firstOutput)) {
			record(
				"output is bucket-shaped",
				false,
				`kind ${firstOutput.kind} has no bucket to list`,
			);
			return;
		}
		const output = firstOutput;
		const outCred = await credentials.get(output.credentialId);
		if (!outCred) {
			record("output credential exists", false, output.credentialId);
			return;
		}
		const outBrowser = createBrowserForCredential({
			provider: outCred.provider,
			config: (outCred.config ?? {}) as Record<string, unknown>,
			secret: JSON.parse(
				await credentials.revealSecret(output.credentialId),
			) as Record<string, string>,
		});
		// There is no outputPrefix column: the base path lives in the plan, on each
		// muxing/manifest destination. Take the shortest muxing path as the base.
		const paths = [
			...(plan.muxings ?? []).map((m) => m.destination?.path ?? ""),
			...(plan.manifests ?? []).map((m) => m.destination?.path ?? ""),
		].filter((p) => p.length > 0);
		const base = paths.sort((a, b) => a.length - b.length)[0] ?? "";
		// listObjects is delimiter-based (one level per call), so listing the base
		// prefix alone returned 7 objects and none of the per-rendition folders — the
		// first thing this verifier caught was its own blind spot. Walk every prefix
		// the plan declares plus the base.
		const prefixes = [
			base,
			...new Set(
				(plan.muxings ?? [])
					.map((m) => m.destination?.path ?? "")
					.filter((p) => p.length > 0),
			),
		];
		const keys: string[] = [];
		for (const prefix of prefixes) {
			const listing = await outBrowser.listObjects({
				bucket: output.bucket,
				prefix,
				limit: 100,
			});
			keys.push(...listing.objects.map((o) => o.key));
		}
		record(
			"output prefix has objects",
			keys.length > 0,
			`${keys.length} under "${base}"`,
		);

		// Manifests the plan asked for must EXIST as files.
		for (const m of plan.manifests ?? []) {
			// `manifestName` is HLS/DASH only — Smooth names its files differently, so an
			// empty name skips the check rather than asserting on `undefined`.
			const name = "manifestName" in m ? (m.manifestName ?? "") : "";
			const hit = keys.find((k) => k.endsWith(name));
			record(
				`manifest written: ${name || m.kind}`,
				hit !== undefined,
				hit ?? `not found under ${base}`,
			);
		}

		// Every QC mirror the plan implies must exist and match its rendition.
		// `height == null` covers BOTH undefined and null: filtering on `!== null`
		// alone let the audio rungs through as "/undefinedp/qc/".
		const videoRungs = plan.renditions.filter(
			(x): x is typeof x & { height: number } =>
				"height" in x && x.height != null,
		);
		for (const r of videoRungs) {
			const qc = keys.find(
				(k) => k.includes(`/${r.height}p/qc/`) && k.endsWith(".mp4"),
			);
			if (!qc) {
				console.log(
					`        objects seen: ${keys.length} — ${keys.slice(0, 12).join(", ")}`,
				);
			}
			if (!qc) {
				record(`qc mirror for ${r.key}`, false, `no /${r.height}p/qc/*.mp4`);
				continue;
			}
			const p = join(dir, `qc-${r.key}.mp4`);
			await fetchTo(outBrowser, output.bucket, qc, p);
			const q = await probe(p);
			record(
				`qc mirror for ${r.key} matches the plan`,
				q.height === r.height,
				`plan height=${r.height} actual=${q.width}x${q.height} ` +
					`r_frame_rate=${q.rFrameRate} nb_frames=${q.nbFrames} duration=${q.duration}`,
			);
			// Frame counts must line up: the VOD scorer pairs frame i with frame i and
			// has no alignment search, so a mismatch here IS a wrong VMAF score.
			const refFrames = Number(refProbe.nbFrames);
			const qcFrames = Number(q.nbFrames);
			if (Number.isFinite(refFrames) && Number.isFinite(qcFrames)) {
				record(
					`qc mirror for ${r.key} has the reference's frame count`,
					refFrames === qcFrames,
					`reference=${refFrames} distorted=${qcFrames} (delta ${qcFrames - refFrames})`,
				);
			}
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
		await prisma.$disconnect();
	}

	const failed = checks.filter((c) => !c.ok).length;
	console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
	process.exit(failed);
}

await main();
