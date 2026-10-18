/**
 * DEV SEED — VMAF Lab.
 *
 * Inserts ONE FINISHED VmafJob + three VmafResult rows with synthetic but
 * realistic per-frame VMAF series (a 360p/540p/1080p ladder, ~600 frames
 * each, with a visible quality dip around the middle so the worst-frame,
 * 1%-low and percentile views are interesting). The 1080p rung ALSO carries a
 * per-frame PSNR (dB) series + pooled PSNR (P4-PR5) so the PSNR table columns,
 * the secondary-axis toggle on the frame chart, and the psnr CSV/JSON export
 * are all exercised — the other rungs omit PSNR so the report also shows the
 * graceful mixed (em-dash) cells. framesGzip is written exactly as the worker
 * writes it — `gzip(JSON.stringify([{ frameNum, vmaf, psnr? }]))` — and the
 * pooled metrics come from core's `computePooled`/`computePsnrPooled`, so the
 * report renders end-to-end against the dev DB with no real encode.
 *
 * Idempotent: the job uses a FIXED id, so re-running replaces it (results
 * cascade-delete). It is clearly labelled "[dev seed]" in the job name path
 * via the linked encoding job (when one exists) and a console banner.
 *
 * Run:  pnpm --filter @bitovp/web seed:vmaf -- --organization-id <UUID>
 * (requires DATABASE_URL — i.e. `docker compose up` + migrations applied.)
 *
 * This file is NEVER imported by the app; it is a standalone tsx script.
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
	computePooled,
	computePsnrPooled,
	VMAF_SCORING_VERSION,
	type VmafFrame,
} from "@bitovp/core";
import { getIdentityPrisma, getTenantPrisma } from "@bitovp/db";

/**
 * Stable per-organization id: re-seeding replaces this organization's demo
 * without colliding with another organization's global UUID primary key.
 */
function seedJobId(organizationId: string): string {
	const hex = createHash("sha256")
		.update(`bitovp-vmaf-demo:${organizationId}`)
		.digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

type RenditionSpec = {
	label: string;
	height: number;
	bitrate: number;
	/** Baseline VMAF this rendition hovers around (higher rung = higher mean). */
	baseline: number;
	/**
	 * When set, also synthesize a per-frame PSNR (dB) series tracking this
	 * baseline — exercises the PSNR table columns + secondary-axis chart + the
	 * CSV/JSON psnr export (P4-PR5). Left off on the other rungs so the report
	 * also shows the graceful mixed-PSNR (em-dash) cells.
	 */
	psnrBaseline?: number;
};

const LADDER: RenditionSpec[] = [
	{ label: "360p", height: 360, bitrate: 800_000, baseline: 84 },
	{ label: "540p", height: 540, bitrate: 1_600_000, baseline: 91 },
	// 1080p carries PSNR so the dB columns/axis/export are exercised end-to-end.
	{
		label: "1080p",
		height: 1080,
		bitrate: 4_500_000,
		baseline: 96,
		psnrBaseline: 45,
	},
];

const FRAME_COUNT = 600;
// A pronounced dip (hard-to-encode scene) centred mid-clip — this is what the
// worst-frame marker, 1%-low and low percentiles should surface.
const DIP_CENTER = 320;
const DIP_WIDTH = 22;
const DIP_DEPTH = 28;

/** Deterministic pseudo-random in [0,1) — keeps the seed reproducible. */
function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 0xffffffff;
	};
}

function makeFrames(spec: RenditionSpec, seed: number): VmafFrame[] {
	const rand = rng(seed);
	const frames: VmafFrame[] = [];
	for (let i = 0; i < FRAME_COUNT; i++) {
		// Gentle wave + small jitter around the baseline.
		const wave = Math.sin(i / 18) * 1.5;
		const jitter = (rand() - 0.5) * 2.5;
		// Gaussian-ish dip near DIP_CENTER (scaled by the rung — lower rungs
		// suffer the hard scene more, like a real ladder).
		const dip =
			DIP_DEPTH *
			(spec.baseline < 90 ? 1 : 0.55) *
			Math.exp(-((i - DIP_CENTER) ** 2) / (2 * DIP_WIDTH ** 2));
		const score = spec.baseline + wave + jitter - dip;
		const frame: VmafFrame = {
			frameNum: i,
			vmaf: Math.max(0, Math.min(100, Number(score.toFixed(3)))),
		};
		if (spec.psnrBaseline !== undefined) {
			// PSNR tracks the same dip (smaller dB swing); clamp at 100 (cap).
			const psnr = spec.psnrBaseline + wave * 0.4 + jitter * 0.3 - dip * 0.25;
			frame.psnr = Math.max(0, Math.min(100, Number(psnr.toFixed(3))));
		}
		frames.push(frame);
	}
	return frames;
}

async function main() {
	const args = process.argv.slice(2);
	const organizationId = args[args.indexOf("--organization-id") + 1];
	if (
		!args.includes("--organization-id") ||
		!organizationId ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			organizationId,
		)
	) {
		throw new Error(
			"Usage: seed:vmaf -- --organization-id <active organization UUID>",
		);
	}
	const organization = await getIdentityPrisma().organization.findUnique({
		where: { id: organizationId },
		select: { active: true },
	});
	if (!organization?.active) throw new Error("Organization is unavailable");
	const prisma = getTenantPrisma(organizationId);
	const jobId = seedJobId(organizationId);
	console.log("[dev seed] VMAF Lab — seeding job", jobId);

	// Reuse an existing encoding job to make the cross-link work, if any exist;
	// otherwise leave it null (the report renders standalone).
	const encodingJob = await prisma.encodingJob.findFirst({
		orderBy: { createdAt: "desc" },
		select: { id: true, name: true },
	});
	if (encodingJob) {
		console.log(
			`[dev seed] linking to encoding job ${encodingJob.id} (“${encodingJob.name}”)`,
		);
	} else {
		console.log("[dev seed] no encoding job found — report will be standalone");
	}

	// Replace any prior seed (results cascade on delete).
	await prisma.vmafJob.deleteMany({ where: { id: jobId } });

	await prisma.vmafJob.create({
		data: {
			id: jobId,
			encodingJobId: encodingJob?.id ?? null,
			mode: "VOD",
			model: "vmaf_v0.6.1",
			/**
			 * The CURRENT generation, explicitly. These numbers are synthetic — they
			 * came from neither pipeline — so the column default (1, which exists to
			 * label genuinely historical rows) would make the QC screens warn that
			 * seeded demo data is "understated". Current is the label that does not
			 * lie about anything an operator can act on.
			 */
			scoringVersion: VMAF_SCORING_VERSION,
			status: "FINISHED",
			results: {
				create: LADDER.map((spec, i) => {
					const frames = makeFrames(spec, 1000 + i * 7);
					const pooled = computePooled(frames);
					// Attach pooled PSNR for the rung that carries per-frame psnr.
					const psnrValues = frames
						.map((f) => f.psnr)
						.filter((v): v is number => typeof v === "number");
					const psnrPooled = computePsnrPooled(psnrValues);
					if (psnrPooled) {
						pooled.psnr = psnrPooled;
					}
					return {
						renditionRef: {
							label: spec.label,
							height: spec.height,
							bitrate: spec.bitrate,
							streamId: `seed-stream-${spec.label}`,
						},
						pooled: pooled as unknown as object,
						framesGzip: gzipSync(Buffer.from(JSON.stringify(frames), "utf8")),
					};
				}),
			},
		},
	});

	console.log(
		`[dev seed] done — ${LADDER.length} renditions × ${FRAME_COUNT} frames. View at /qc/${jobId}`,
	);
	process.exit(0);
}

main().catch(async (err) => {
	console.error("[dev seed] failed:", err);
	process.exitCode = 1;
});
