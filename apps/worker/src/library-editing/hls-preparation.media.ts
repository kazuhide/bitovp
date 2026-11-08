import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { matchesWhere } from "@bitovp/core/testing";
import type { AppPrismaClient } from "@bitovp/db";
import {
	type ObjectStorageBrowser,
	ObjectVersionMismatchError,
} from "@bitovp/storage";
import { runMediaProcess } from "./process";
import { createLibraryEditingSweep } from "./sweep";

const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

for (const layout of ["FMP4_SEPARATE_AUDIO", "TS_MULTIPLEXED"] as const)
	test(`native normal PREPARE captures pinned ${layout} and publishes indexed READY without an AISA binding`, async () => {
		const base = process.env.BITOVP_HLS_NATIVE_OUT,
			ffmpeg = process.env.BITOVP_HLS_FFMPEG,
			ffprobe = process.env.BITOVP_HLS_FFPROBE;
		assert.ok(
			base && ffmpeg && ffprobe,
			"Explicit owned output and pinned ffmpeg/ffprobe wrappers are required",
		);
		await mkdir(base, { recursive: true });
		const directory = await mkdtemp(join(base, "native-"));
		const original = join(directory, "authored-cfr24.mp4"),
			args = [
				"-hide_banner",
				"-v",
				"error",
				"-nostdin",
				"-f",
				"lavfi",
				"-i",
				"testsrc2=size=160x90:rate=24",
				"-f",
				"lavfi",
				"-i",
				"sine=frequency=880:sample_rate=48000",
				"-t",
				"4",
				"-threads",
				"2",
				"-c:v",
				"libx264",
				"-g",
				"24",
				"-crf",
				"18",
				"-pix_fmt",
				"yuv420p",
				"-color_primaries",
				"bt709",
				"-color_trc",
				"bt709",
				"-colorspace",
				"bt709",
				"-x264-params",
				"colorprim=bt709:transfer=bt709:colormatrix=bt709",
				"-c:a",
				"aac",
				"-ar",
				"48000",
				"-ac",
				"2",
				"-movflags",
				"+faststart",
				original,
			];
		await runMediaProcess(ffmpeg, args, { timeoutMs: 60000 });
		const objects = new Map<string, Buffer>();
		if (layout === "FMP4_SEPARATE_AUDIO") {
			for (const kind of ["video", "audio"]) {
				const folder = join(directory, kind);
				await mkdir(folder);
				await runMediaProcess(
					ffmpeg,
					[
						"-hide_banner",
						"-v",
						"error",
						"-nostdin",
						"-i",
						original,
						"-map",
						kind === "video" ? "0:v:0" : "0:a:0",
						"-c",
						"copy",
						"-f",
						"hls",
						"-hls_time",
						"1",
						"-hls_playlist_type",
						"vod",
						"-hls_segment_type",
						"fmp4",
						"-hls_fmp4_init_filename",
						"init.mp4",
						"-hls_segment_filename",
						join(folder, "segment_%03d.m4s"),
						join(folder, "stream.m3u8"),
					],
					{ timeoutMs: 60000 },
				);
			}
			const master =
				'#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",DEFAULT=YES,AUTOSELECT=YES,URI="audio/stream.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=160x90,CODECS="avc1.64000b,mp4a.40.2",AUDIO="a"\nvideo/stream.m3u8\n';
			await writeFile(join(directory, "stream.m3u8"), master);
			objects.set("retained/stream.m3u8", Buffer.from(master));
			for (const kind of ["video", "audio"])
				for (const name of await readdir(join(directory, kind)))
					objects.set(
						`retained/${kind}/${name}`,
						await readFile(join(directory, kind, name)),
					);
		} else {
			await runMediaProcess(
				ffmpeg,
				[
					"-hide_banner",
					"-v",
					"error",
					"-nostdin",
					"-i",
					original,
					"-map",
					"0:v:0",
					"-map",
					"0:a:0",
					"-c",
					"copy",
					"-f",
					"hls",
					"-hls_time",
					"1",
					"-hls_playlist_type",
					"vod",
					"-hls_segment_type",
					"mpegts",
					"-hls_segment_filename",
					join(directory, "segment_%03d.ts"),
					join(directory, "stream.m3u8"),
				],
				{ timeoutMs: 60000 },
			);
			for (const name of await readdir(directory))
				if (name.endsWith(".ts") || name.endsWith(".m3u8"))
					objects.set(
						`retained/${name}`,
						await readFile(join(directory, name)),
					);
		}
		const originalObjects = [...objects].map(([key, bytes]) => [
				key,
				sha(bytes),
			]),
			gets: { key: string; expected?: string }[] = [],
			uploads: string[] = [];
		const browser: ObjectStorageBrowser = {
			listBuckets: async () => [],
			listObjects: async () => ({ objects: [], prefixes: [] }),
			headObject: async ({ key }) => {
				const b = objects.get(key);
				assert.ok(b, `fixture missing ${key}`);
				return { size: b.length, etag: `"${sha(b)}"` };
			},
			getObject: async ({ key, expect }) => {
				const b = objects.get(key);
				assert.ok(b);
				gets.push({ key, expected: expect?.etag });
				if (expect?.etag !== `"${sha(b)}"`)
					throw new ObjectVersionMismatchError("fixture", key, expect ?? {});
				return Readable.from([b]);
			},
			putObject: async ({ key, filePath }) => {
				assert.ok(filePath);
				objects.set(key, await readFile(filePath));
				uploads.push(key);
			},
		};
		const now = new Date(),
			root = objects.get("retained/stream.m3u8");
		assert.ok(root);
		const media: Record<string, unknown> = {
			id: id(1),
			sourceId: id(2),
			organizationId: id(3),
			state: "PENDING",
			attempts: 0,
			availableAt: now,
			leaseToken: null,
			leaseUntil: null,
			storage: {
				source: {
					credentialId: id(4),
					bucket: "fixture",
					key: "retained/stream.m3u8",
					size: root.length,
					expect: { etag: `"${sha(root)}"` },
				},
				output: { credentialId: id(4), bucket: "fixture", prefix: "prepared/" },
				sourceFormat: "HLS",
				hlsRootPrefix: "retained/",
			},
		};
		const receipts: Record<string, unknown>[] = [],
			tx = {
				libraryMediaVersion: {
					updateMany: async ({
						where,
						data,
					}: {
						where: Record<string, unknown>;
						data: Record<string, unknown>;
					}) => {
						if (!matchesWhere(media, where)) return { count: 0 };
						for (const [k, v] of Object.entries(data))
							media[k] =
								v && typeof v === "object" && "increment" in v
									? Number(media[k]) + Number(v.increment)
									: v;
						return { count: 1 };
					},
				},
				libraryEvidenceReceipt: {
					findMany: async ({ where }: { where: Record<string, unknown> }) =>
						receipts.filter((row) =>
							matchesWhere(row, where, (_row, field) =>
								field === "mediaVersion" ? media : undefined,
							),
						),
					create: async ({ data }: { data: Record<string, unknown> }) => {
						const row = { id: id(50), ...data };
						receipts.push(row);
						return row;
					},
				},
				$queryRaw: async () => [],
			};
		const db = {
			...tx,
			libraryMediaVersion: {
				...tx.libraryMediaVersion,
				findMany: async ({ where }: { where: Record<string, unknown> }) =>
					matchesWhere(media, where) ? [media] : [],
			},
			renderRun: {
				findMany: async () => [],
				updateMany: async () => ({ count: 0 }),
			},
			$transaction: async <T>(fn: (client: typeof tx) => Promise<T>) => fn(tx),
		} as unknown as AppPrismaClient;
		try {
			await createLibraryEditingSweep({
				canClaim: async () => true,
				prisma: db,
				browserFor: async () => browser,
				now: () => now,
				ffmpegPath: ffmpeg,
				ffprobePath: ffprobe,
			})();
		} catch (error) {
			await writeFile(
				join(directory, "failure.json"),
				`${JSON.stringify(
					{
						state: media.state,
						error: media.error,
						receipts: receipts.map((r) => ({
							kind: r.kind,
							sourceId: r.sourceId,
						})),
						gets,
						uploads,
						code: error instanceof Error ? error.message : "unknown",
					},
					null,
					2,
				)}\n`,
			);
			throw error;
		}
		assert.equal(
			media.state,
			"READY",
			JSON.stringify({ state: media.state, error: media.error }),
		);
		assert.equal(media.fpsNum, 30);
		assert.equal(media.durationUs, 4000000n);
		assert.equal(receipts.length, 1);
		assert.equal(receipts[0]?.kind, "NORMALIZATION_CAPTURE");
		const probe = media.probe as Record<string, unknown>,
			witness = probe.sourceMaterialization as {
				remuxSha256: string;
				remuxBytes: number;
				objects: { key: string; sha256: string }[];
			};
		assert.ok(witness);
		const receipt = receipts[0]?.proof as {
			originalSha256: string;
			originalBytes: number;
			preparedSha256: string;
			output: { frameCount: number; hasAudio: boolean };
		};
		assert.equal(receipt.originalSha256, witness.remuxSha256);
		assert.equal(receipt.originalBytes, witness.remuxBytes);
		assert.notEqual(receipt.originalSha256, sha(root));
		assert.equal(receipt.output.frameCount, 120);
		assert.equal(receipt.output.hasAudio, true);
		assert.equal(witness.objects.length, originalObjects.length);
		assert.equal(gets.length, originalObjects.length);
		assert.equal(uploads.length, 1);
		for (const [key, expected] of originalObjects)
			assert.equal(sha(objects.get(String(key)) ?? Buffer.alloc(0)), expected);
		const prepared = objects.get(uploads[0] ?? "");
		assert.ok(prepared);
		assert.equal(sha(prepared), media.sha256);
		const copied = join(directory, "prepared-ready.mp4");
		await writeFile(copied, prepared);
		const inspected = await runMediaProcess(
			ffprobe,
			[
				"-v",
				"error",
				"-count_frames",
				"-show_streams",
				"-show_format",
				"-of",
				"json",
				copied,
			],
			{ timeoutMs: 60000 },
		);
		const actual = JSON.parse(inspected.stdout) as {
			streams: {
				codec_type: string;
				codec_name: string;
				nb_read_frames?: string;
				sample_rate?: string;
				avg_frame_rate?: string;
			}[];
		};
		assert.equal(
			actual.streams.find((s) => s.codec_type === "video")?.nb_read_frames,
			"120",
		);
		assert.equal(
			actual.streams.find((s) => s.codec_type === "video")?.avg_frame_rate,
			"30/1",
		);
		assert.equal(
			actual.streams.find((s) => s.codec_type === "audio")?.codec_name,
			"aac",
		);
		assert.equal(
			actual.streams.find((s) => s.codec_type === "audio")?.sample_rate,
			"48000",
		);
		const result = {
			kind: "SYNTHETIC_HLS_FIXTURE_NORMAL_PREPARE_NOT_PROVIDER_AISA",
			layout,
			status: "PASS",
			directory,
			sourceObjects: originalObjects,
			gets,
			uploads,
			readySha256: media.sha256,
			normalizationReceipt: receipt,
			witness,
			probe: JSON.parse(inspected.stdout),
			realDatabase: false,
			remoteStorage: false,
			providerBindingsCreated: 0,
		};
		await writeFile(
			join(directory, "result.json"),
			`${JSON.stringify(result, null, 2)}\n`,
		);
		console.log(
			JSON.stringify({
				status: "PASS",
				layout,
				directory,
				frames: 120,
				sourceObjects: originalObjects.length,
				providerBindingsCreated: 0,
			}),
		);
	});
