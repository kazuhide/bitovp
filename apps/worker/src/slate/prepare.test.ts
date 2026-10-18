import { readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { MediaAttributes, ProbeResult } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getObject = vi.fn();
const putObject = vi.fn();
const dispose = vi.fn();
let browserHasPut = true;

/**
 * One browser per CREDENTIAL, with its own spies: the destination test must
 * see WHICH credential uploaded, not merely that two browsers were minted
 * (review of #556, H1).
 */
const browsersCreated: string[] = [];
const browserByKey = new Map<
	string,
	{ putObject: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }
>();
function spiesFor(accessKeyId: string) {
	let entry = browserByKey.get(accessKeyId);
	if (!entry) {
		entry = {
			putObject: vi.fn(async (...args: unknown[]) => putObject(...args)),
			dispose: vi.fn(() => dispose()),
		};
		browserByKey.set(accessKeyId, entry);
	}
	return entry;
}
vi.mock("@bitovp/storage", () => ({
	createBrowserForCredential: (cred: { secret: { accessKeyId?: string } }) => {
		const id = cred.secret.accessKeyId ?? "?";
		browsersCreated.push(id);
		const spies = spiesFor(id);
		return {
			listBuckets: vi.fn(),
			listObjects: vi.fn(),
			getObject,
			...(browserHasPut ? { putObject: spies.putObject } : {}),
			dispose: spies.dispose,
		};
	},
}));

import { createSlatePreparer } from "./prepare";

const INGEST: MediaAttributes = {
	video: { codec: "h264", width: 1280, height: 720, frameRate: 30 },
	audio: [{ codec: "aac", sampleRate: 48000 }],
};
const SOURCE = {
	credentialId: "3e7a9b1c-0d2f-4e5a-8b6c-7d8e9f0a1b2c",
	bucket: "slates-bucket",
	key: "slates/brb.mp4",
};
/** The channel's own S3 output : a different credential and bucket. */
const DEST = {
	credentialId: "4c885bd1-33ef-47b0-9506-3b765f91f324",
	bucket: "channel-output",
	keyPrefix: "chan-1/slates",
	outputKey: "archive-s3",
};
const MP4: ProbeResult = {
	format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
	streams: [
		{
			codec_type: "video",
			codec_name: "h264",
			width: 1280,
			height: 720,
			r_frame_rate: "30/1",
			pix_fmt: "yuv420p",
		},
		{
			codec_type: "audio",
			codec_name: "aac",
			sample_rate: "48000",
			channels: 2,
		},
	],
};
const TS: ProbeResult = { ...MP4, format: { format_name: "mpegts" } };
const PNG: ProbeResult = {
	format: { format_name: "png_pipe" },
	streams: [
		{ codec_type: "video", codec_name: "png", width: 500, height: 500 },
	],
};

function makeDeps(over: {
	recorded?: ProbeResult | null;
	probed?: ProbeResult | null;
	ffmpeg?: { code: number | null; stderr?: string };
	maxSourceBytes?: number;
}) {
	const workDir = join(
		tmpdir(),
		`slate-prep-${Math.random().toString(16).slice(2)}`,
	);
	const runner = {
		spawn: vi.fn(),
		run: vi.fn(async (_bin: string, argv: string[]) => {
			// The "transcode": write the destination so the upload has bytes.
			const dest = argv[argv.length - 1] as string;
			if ((over.ffmpeg?.code ?? 0) === 0) {
				await writeFile(dest, Buffer.from("ts-bytes"));
			}
			return {
				code: over.ffmpeg?.code ?? 0,
				stdout: "",
				stderr: over.ffmpeg?.stderr ?? "",
			};
		}),
	};
	const prisma = {
		storageInspection: {
			findFirst: vi.fn(async () =>
				over.recorded === undefined
					? null
					: over.recorded === null
						? null
						: { probe: over.recorded },
			),
		},
	} as unknown as AppPrismaClient;
	const probeObject = vi.fn(async () => over.probed ?? null);
	const deps = {
		prisma,
		resolveCredential: vi.fn(async (credentialId: string) => ({
			provider: "AWS_S3",
			config: {},
			secret: {
				accessKeyId: credentialId === DEST.credentialId ? "ak-out" : "ak",
				secretAccessKey: "sk",
			},
		})),
		probeObject,
		runner,
		ffmpegPath: "/usr/bin/ffmpeg",
		workDir,
		...(over.maxSourceBytes !== undefined
			? { maxSourceBytes: over.maxSourceBytes }
			: {}),
	};
	return { deps, runner, probeObject, workDir };
}

beforeEach(() => {
	vi.clearAllMocks();
	browsersCreated.length = 0;
	browserByKey.clear();
	browserHasPut = true;
	getObject.mockImplementation(async () =>
		Readable.from([Buffer.alloc(1024, 7)]),
	);
	putObject.mockResolvedValue(undefined);
});

describe("createSlatePreparer", () => {
	it("passes a still image through without touching storage, with or without a reference", async () => {
		const { deps, runner } = makeDeps({ recorded: PNG });
		const prepare = createSlatePreparer(deps);
		await expect(
			prepare({ label: "a", source: SOURCE, ingest: null }),
		).resolves.toEqual({
			kind: "READY",
			source: SOURCE,
			normalized: false,
			target: null,
			note: "still image — registered as it is",
		});
		expect(runner.run).not.toHaveBeenCalled();
		expect(getObject).not.toHaveBeenCalled();
	});

	it("passes a matching MPEG-TS through, using the recorded inspection instead of a fresh probe", async () => {
		const { deps, probeObject } = makeDeps({ recorded: TS });
		const result = await createSlatePreparer(deps)({
			label: "b",
			source: SOURCE,
			ingest: INGEST,
		});
		expect(result).toMatchObject({ kind: "READY", normalized: false });
		expect(probeObject).not.toHaveBeenCalled();
	});

	it("falls back to the bounded probe when nothing is recorded, and WAITS for the input on a movie with no reference", async () => {
		const { deps, probeObject } = makeDeps({ recorded: null, probed: MP4 });
		const result = await createSlatePreparer(deps)({
			label: "c",
			source: SOURCE,
			ingest: null,
		});
		expect(probeObject).toHaveBeenCalledWith({
			label: "slate-prep-c",
			...SOURCE,
		});
		expect(result).toEqual({
			kind: "WAIT",
			note: "waiting for the live input (ingest reference not known yet)",
		});
	});

	it("normalizes an MP4: downloads the whole object, runs ffmpeg to MPEG-TS, uploads next to the source, and leaves no scratch file", async () => {
		const { deps, runner, workDir } = makeDeps({ recorded: MP4 });
		const result = await createSlatePreparer(deps)({
			label: "d",
			source: SOURCE,
			ingest: INGEST,
		});
		expect(result).toEqual({
			kind: "READY",
			source: {
				...SOURCE,
				key: "slates/brb.mp4.normalized-1280x720-30-48000-2ch.ts",
			},
			normalized: true,
			target: {
				width: 1280,
				height: 720,
				frameRate: 30,
				sampleRate: 48000,
				channels: 2,
				channelsAssumed: true,
			},
			note: "converted to MPEG-TS 1280x720 30 fps, AAC 48000 Hz 2ch to match the live input (container) → slates-bucket/slates/brb.mp4.normalized-1280x720-30-48000-2ch.ts; channel count assumed stereo (the live input reports none)",
		});
		expect(getObject).toHaveBeenCalledWith({
			bucket: SOURCE.bucket,
			key: SOURCE.key,
		});
		const [bin, argv] = runner.run.mock.calls[0] as [string, string[]];
		expect(bin).toBe("/usr/bin/ffmpeg");
		expect(argv[argv.indexOf("-i") + 1]).toBe(join(workDir, "slate-d-src.mp4"));
		expect(argv.slice(-3)).toEqual([
			"-f",
			"mpegts",
			join(workDir, "slate-d.ts"),
		]);
		expect(putObject).toHaveBeenCalledWith({
			bucket: SOURCE.bucket,
			key: "slates/brb.mp4.normalized-1280x720-30-48000-2ch.ts",
			filePath: join(workDir, "slate-d.ts"),
			contentType: "video/mp2t",
		});
		expect(dispose).toHaveBeenCalled();
		await expect(readdir(workDir)).resolves.toEqual([]);
	});

	it("reports progress after the download and after the transcode, so a caller can refresh its claim", async () => {
		const { deps } = makeDeps({ recorded: MP4 });
		const onProgress = vi.fn(async (_note: string) => {});
		await createSlatePreparer(deps)({
			label: "p",
			source: SOURCE,
			ingest: INGEST,
			onProgress,
		});
		expect(onProgress.mock.calls.map((c) => c[0])).toEqual([
			"downloaded 0 MB, converting to MPEG-TS",
			"converted, uploading the MPEG-TS to slates-bucket/slates/brb.mp4.normalized-1280x720-30-48000-2ch.ts",
		]);
	});

	it("a failing progress touch does not discard the conversion", async () => {
		const { deps } = makeDeps({ recorded: MP4 });
		const result = await createSlatePreparer(deps)({
			label: "t",
			source: SOURCE,
			ingest: INGEST,
			onProgress: async () => {
				throw new Error("db down");
			},
		});
		expect(result).toMatchObject({ kind: "READY", normalized: true });
		expect(putObject).toHaveBeenCalledTimes(1);
	});

	it("ignores a recorded inspection older than the freshness window and re-probes", async () => {
		const { deps, probeObject } = makeDeps({ recorded: null, probed: MP4 });
		// The mock's findFirst ignores its `where`; the contract under test is
		// that the query CARRIES the age bound, which the real DB applies.
		const findFirst = (
			deps.prisma as unknown as {
				storageInspection: { findFirst: ReturnType<typeof vi.fn> };
			}
		).storageInspection.findFirst;
		await createSlatePreparer(deps)({
			label: "q",
			source: SOURCE,
			ingest: INGEST,
		});
		const where = (
			(findFirst.mock.calls[0] as unknown[] | undefined)?.[0] as {
				where: { status: string; createdAt: { gte: Date } };
			}
		).where;
		expect(where.status).toBe("FINISHED");
		expect(Date.now() - where.createdAt.gte.getTime()).toBeGreaterThan(
			29 * 60_000,
		);
		expect(probeObject).toHaveBeenCalledTimes(1);
	});

	it("with a channel destination, uploads under its prefix through ITS credential and registers from there", async () => {
		const { deps, runner, workDir } = makeDeps({ recorded: MP4 });
		const result = await createSlatePreparer(deps)({
			label: "dest",
			source: SOURCE,
			ingest: INGEST,
			destination: DEST,
		});
		const KEY =
			"chan-1/slates/slates-bucket/slates/brb.mp4.normalized-1280x720-30-48000-2ch.ts";
		expect(result).toMatchObject({
			kind: "READY",
			normalized: true,
			source: {
				credentialId: DEST.credentialId,
				bucket: DEST.bucket,
				key: KEY,
			},
		});
		expect((result as { note: string }).note).toContain(
			`→ channel-output/${KEY}`,
		);
		// Download with the source's credential, upload with the output's.
		expect(getObject).toHaveBeenCalledWith({
			bucket: SOURCE.bucket,
			key: SOURCE.key,
		});
		expect(browsersCreated).toEqual(["ak", "ak-out"]);
		expect(spiesFor("ak").putObject).not.toHaveBeenCalled();
		expect(spiesFor("ak-out").putObject).toHaveBeenCalledWith({
			bucket: DEST.bucket,
			key: KEY,
			filePath: join(workDir, "slate-dest.ts"),
			contentType: "video/mp2t",
		});
		expect(runner.run).toHaveBeenCalledTimes(1);
		expect(spiesFor("ak").dispose).toHaveBeenCalledTimes(1);
		expect(spiesFor("ak-out").dispose).toHaveBeenCalledTimes(1);
		await expect(readdir(workDir)).resolves.toEqual([]);
	});

	it("a destination on the SAME credential reuses one browser", async () => {
		const { deps } = makeDeps({ recorded: MP4 });
		await createSlatePreparer(deps)({
			label: "same",
			source: SOURCE,
			ingest: INGEST,
			destination: { ...DEST, credentialId: SOURCE.credentialId },
		});
		expect(browsersCreated).toEqual(["ak"]);
		expect(spiesFor("ak").dispose).toHaveBeenCalledTimes(1);
		expect(spiesFor("ak").putObject).toHaveBeenCalledWith(
			expect.objectContaining({ bucket: DEST.bucket }),
		);
	});

	it("the downloaded bytes are the object's bytes", async () => {
		const { deps, runner, workDir } = makeDeps({ recorded: MP4 });
		getObject.mockImplementationOnce(async () =>
			Readable.from([Buffer.from("abc"), Buffer.from("def")]),
		);
		const captured: { bytes?: Buffer } = {};
		runner.run.mockImplementationOnce(async (_bin: string, argv: string[]) => {
			captured.bytes = await readFile(argv[argv.indexOf("-i") + 1] as string);
			await writeFile(argv[argv.length - 1] as string, "x");
			return { code: 0, stdout: "", stderr: "" };
		});
		await createSlatePreparer(deps)({
			label: "e",
			source: SOURCE,
			ingest: INGEST,
		});
		expect(captured.bytes?.toString()).toBe("abcdef");
		await expect(readdir(workDir)).resolves.toEqual([]);
	});

	it("REFUSES (never throws) when ffmpeg fails, naming its last lines", async () => {
		const { deps, workDir } = makeDeps({
			recorded: MP4,
			ffmpeg: {
				code: 1,
				stderr: "line1\nInvalid data found when processing input\n",
			},
		});
		const result = await createSlatePreparer(deps)({
			label: "f",
			source: SOURCE,
			ingest: INGEST,
		});
		expect(result).toEqual({
			kind: "REFUSED",
			reason:
				"ffmpeg could not convert the file (exit 1): line1 | Invalid data found when processing input",
		});
		expect(putObject).not.toHaveBeenCalled();
		// Customer bytes never outlive a FAILED call either (review of #552, H1).
		await expect(readdir(workDir)).resolves.toEqual([]);
		expect(dispose).toHaveBeenCalled();
	});

	it("REFUSES a provider that cannot receive the upload, before downloading anything", async () => {
		browserHasPut = false;
		const { deps } = makeDeps({ recorded: MP4 });
		const result = await createSlatePreparer(deps)({
			label: "g",
			source: SOURCE,
			ingest: INGEST,
		});
		expect(result).toMatchObject({ kind: "REFUSED" });
		expect((result as { reason: string }).reason).toContain(
			"cannot receive the converted file",
		);
		expect(getObject).not.toHaveBeenCalled();
		expect(dispose).toHaveBeenCalled();
	});

	it("REFUSES an object over the size bound, mid-stream", async () => {
		const { deps, runner, workDir } = makeDeps({
			recorded: MP4,
			maxSourceBytes: 100,
		});
		const result = await createSlatePreparer(deps)({
			label: "h",
			source: SOURCE,
			ingest: INGEST,
		});
		expect(result).toMatchObject({ kind: "REFUSED" });
		expect((result as { reason: string }).reason).toContain("larger than");
		expect(runner.run).not.toHaveBeenCalled();
		await expect(readdir(workDir)).resolves.toEqual([]);
		expect(dispose).toHaveBeenCalled();
	});

	it("REFUSES what cannot be normalized: an unprobeable object", async () => {
		const { deps } = makeDeps({ recorded: null, probed: null });
		const result = await createSlatePreparer(deps)({
			label: "i",
			source: SOURCE,
			ingest: INGEST,
		});
		expect(result).toEqual({
			kind: "REFUSED",
			reason: "the file could not be probed, so nothing is known about it",
		});
	});
});
