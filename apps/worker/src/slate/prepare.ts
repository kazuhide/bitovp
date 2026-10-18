import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import {
	buildSlateNormalizeArgs,
	decideSlatePreparation,
	type MediaAttributes,
	type ProbeResult,
	redactSecrets,
	SLATE_NORMALIZE_MAX_SOURCE_BYTES,
	type SlateConversionDestination,
	type SlateNormalizationTarget,
	type SlateSource,
	slateDestinationKey,
	slateFrameRateToken,
	slateNormalizedKey,
	slateProbeFacts,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import {
	type BrowserCredential,
	createBrowserForCredential,
} from "@bitovp/storage";
import type { ProcessRunner } from "../feeder/supervisor";
import type { BoundedObjectProbe } from "../inspect/processor";
import type { ResolvedCredential } from "../orchestrator/executor";

/**
 * The slate PREPARER : the one piece of work both registration
 * paths share — the direct route's `SlateNormalization` row and the
 * scheduled-source row on `LiveSchedule` — so a slate armed at channel
 * creation and one registered from the channel page end up as the same
 * object at the provider.
 *
 * The decision is `decideSlatePreparation` (core); this module is the
 * execution: probe the object (the storage browser's latest FINISHED
 * inspection when one exists — the direct route always leaves one — else
 * the bounded probe), and for a NORMALIZE verdict download the whole object
 * (bounded), transcode it with ffmpeg to an MPEG-TS that matches the ingest,
 * and upload the result NEXT TO THE SOURCE under a key that names the
 * target, with the same credential that read the source.
 *
 * Every failure inside preparation is returned as REFUSED with its reason
 * rather than thrown: a clip that ffmpeg cannot read, a bucket the
 * credential cannot write, an object over the size bound — retrying cannot
 * fix any of those, and for the scheduled path a throw would mean a retry
 * every sweep tick until the slate window closed. Customer bytes never
 * outlive the call: both scratch files are removed in a `finally`.
 */

export type SlatePreparerDeps = {
	prisma: AppPrismaClient;
	resolveCredential(credentialId: string): Promise<ResolvedCredential>;
	/** Fallback probe when no FINISHED inspection is on record. */
	probeObject: BoundedObjectProbe;
	runner: ProcessRunner;
	ffmpegPath: string;
	workDir: string;
	maxSourceBytes?: number;
	/** Ceiling for one ffmpeg run; past it the transcode is REFUSED. */
	normalizeTimeoutMs?: number;
};

export const DEFAULT_NORMALIZE_TIMEOUT_MS = 10 * 60_000;

export type PreparedSlate =
	| {
			kind: "READY";
			/**
			 * The object the provider is pointed at: the source itself, or the
			 * converted MPEG-TS — in the channel's S3-family output when the plan
			 * has one (its credential is writable by construction), else next to
			 * the source under the source's credential.
			 */
			source: SlateSource;
			normalized: boolean;
			target: SlateNormalizationTarget | null;
			/** Plain English for the row/description — what was done and why. */
			note: string;
	  }
	| { kind: "WAIT"; note: string }
	| { kind: "REFUSED"; reason: string };

export type SlatePreparer = (args: {
	/** Names the scratch files; never customer-derived. */
	label: string;
	source: SlateSource;
	ingest: MediaAttributes | null;
	/**
	 * Where a converted file is written (`slateConversionDestination` of the
	 * channel's plan). Null/absent = next to the source, which then needs a
	 * credential that can write to the source bucket.
	 */
	destination?: SlateConversionDestination | null;
	/**
	 * Called after the download and after the transcode with a one-line
	 * status, so a caller that holds a time-bounded claim (the
	 * SlateNormalization row's stale window) can refresh it while a large
	 * file is still legitimately in flight (review of #552, M3). Best-effort:
	 * a rejected touch is swallowed. Residuals accepted with the review: the
	 * download and the upload themselves are not time-bounded (a link slower
	 * than ~2.4 MB/s on a 2 GiB source can still look stale), and the
	 * 30-minute inspection freshness is a time bound, not a byte identity.
	 */
	onProgress?: (note: string) => Promise<void>;
}) => Promise<PreparedSlate>;

/** The reason the preparation cannot succeed by retrying. */
class PrepareError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PrepareError";
	}
}

/** The last lines of ffmpeg's stderr, for a REFUSED reason. */
function stderrTail(stderr: string): string {
	const lines = stderr
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	return lines.slice(-3).join(" | ").slice(0, 400);
}

/** Awaits one chunk through the sink, so a slow disk applies backpressure. */
function writeChunk(sink: NodeJS.WritableStream, buf: Buffer): Promise<void> {
	return new Promise((resolve, reject) => {
		sink.write(buf, (err) => (err ? reject(err) : resolve()));
	});
}

async function downloadWhole(args: {
	browser: ReturnType<typeof createBrowserForCredential>;
	bucket: string;
	key: string;
	path: string;
	maxBytes: number;
}): Promise<number> {
	if (!args.browser.getObject) {
		throw new PrepareError(
			"the storage provider cannot stream objects, so the file cannot be downloaded for normalization",
		);
	}
	const stream = await args.browser.getObject({
		bucket: args.bucket,
		key: args.key,
	});
	// mode 0600: customer media bytes in a shared work dir.
	const sink = createWriteStream(args.path, { mode: 0o600 });
	let bytes = 0;
	try {
		for await (const chunk of stream as AsyncIterable<Buffer | string>) {
			const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			bytes += buf.length;
			if (bytes > args.maxBytes) {
				throw new PrepareError(
					`the file is larger than the ${Math.round(args.maxBytes / 1024 / 1024)} MB normalization bound`,
				);
			}
			await writeChunk(sink, buf);
		}
	} catch (err) {
		sink.destroy();
		(stream as unknown as { destroy?: () => void }).destroy?.();
		// A destroy that lands before the stream's own open completes still
		// creates the file afterwards; wait for `close` so the caller's rm
		// cannot race the open (measured: the oversize test found the file).
		await new Promise<void>((resolve) => {
			if (sink.closed) {
				resolve();
			} else {
				sink.once("close", () => resolve());
			}
		});
		throw err;
	}
	await new Promise<void>((resolve, reject) => {
		sink.end((err?: Error | null) => (err ? reject(err) : resolve()));
	});
	return bytes;
}

/**
 * How old a recorded inspection may be and still stand in for a probe. An
 * inspection names a KEY, not bytes (no etag/version on the row), so an
 * object overwritten under the same key after an old inspection would be
 * judged — and, for a matching MPEG-TS, registered as it is — on the old
 * file. The direct route inspects minutes before it registers; anything
 * older is re-probed (review of #552, M2).
 */
export const RECORDED_PROBE_MAX_AGE_MS = 30 * 60_000;

/** The storage browser's latest FINISHED inspection of the object, if recent. */
async function recordedProbe(
	prisma: AppPrismaClient,
	source: SlateSource,
	now: Date,
): Promise<ProbeResult | null> {
	const row = await prisma.storageInspection
		.findFirst({
			where: {
				credentialId: source.credentialId,
				bucket: source.bucket,
				objectKey: source.key,
				status: "FINISHED",
				createdAt: { gte: new Date(now.getTime() - RECORDED_PROBE_MAX_AGE_MS) },
			},
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			select: { probe: true },
		})
		.catch(() => null);
	const probe = row?.probe;
	return probe && typeof probe === "object" ? (probe as ProbeResult) : null;
}

export function createSlatePreparer(deps: SlatePreparerDeps): SlatePreparer {
	const maxBytes = deps.maxSourceBytes ?? SLATE_NORMALIZE_MAX_SOURCE_BYTES;
	const timeoutMs = deps.normalizeTimeoutMs ?? DEFAULT_NORMALIZE_TIMEOUT_MS;
	return async function prepare({
		label,
		source,
		ingest,
		destination,
		onProgress,
	}) {
		const probe =
			(await recordedProbe(deps.prisma, source, new Date())) ??
			(await deps.probeObject({
				label: `slate-prep-${label}`,
				credentialId: source.credentialId,
				bucket: source.bucket,
				key: source.key,
			}));
		const decision = decideSlatePreparation(probe, ingest);
		switch (decision.action) {
			case "REGISTER_AS_IS":
				return {
					kind: "READY",
					source,
					normalized: false,
					target: null,
					note:
						decision.reason === "IMAGE"
							? "still image — registered as it is"
							: "MPEG-TS already matches the live input — registered as it is",
				};
			case "WAIT_FOR_INPUT":
				return {
					kind: "WAIT",
					note: `waiting for the live input (${decision.missing.join(", ")} not known yet)`,
				};
			case "REFUSE":
				return { kind: "REFUSED", reason: decision.reason };
			case "NORMALIZE":
				break;
		}
		const { target, reasons } = decision;
		const facts = slateProbeFacts(probe as ProbeResult);
		const srcPath = join(
			deps.workDir,
			`slate-${label}-src${extname(source.key) || ".bin"}`,
		);
		const destPath = join(deps.workDir, `slate-${label}.ts`);
		let browser: ReturnType<typeof createBrowserForCredential> | null = null;
		let uploader: ReturnType<typeof createBrowserForCredential> | null = null;
		try {
			await mkdir(deps.workDir, { recursive: true });
			await rm(srcPath, { force: true });
			await rm(destPath, { force: true });
			const credential = await deps.resolveCredential(source.credentialId);
			browser = createBrowserForCredential({
				provider: credential.provider as BrowserCredential["provider"],
				config: credential.config,
				secret: credential.secret,
			});
			// The upload side: the channel's output storage when the plan names
			// one (writable by construction), else the source's own credential.
			const out: SlateSource = destination
				? {
						credentialId: destination.credentialId,
						bucket: destination.bucket,
						key: slateDestinationKey(destination, source, target),
					}
				: { ...source, key: slateNormalizedKey(source.key, target) };
			if (destination && destination.credentialId !== source.credentialId) {
				const outCredential = await deps.resolveCredential(
					destination.credentialId,
				);
				uploader = createBrowserForCredential({
					provider: outCredential.provider as BrowserCredential["provider"],
					config: outCredential.config,
					secret: outCredential.secret,
				});
			} else {
				uploader = browser;
			}
			if (!uploader.putObject) {
				throw new PrepareError(
					destination
						? `the channel's output storage (${destination.outputKey}) cannot receive the converted file — its credential is not S3-family`
						: `storage provider ${credential.provider} cannot receive the converted file — conversion needs an S3-family credential, or a channel output on one`,
				);
			}
			const bytes = await downloadWhole({
				browser,
				bucket: source.bucket,
				key: source.key,
				path: srcPath,
				maxBytes: maxBytes,
			});
			// Best-effort: a touch that fails must not discard the work it
			// protects (a missed touch only risks a stale-looking claim).
			await onProgress?.(
				`downloaded ${Math.round(bytes / 1024 / 1024)} MB, converting to MPEG-TS`,
			)?.catch(() => {});
			const result = await deps.runner.run(
				deps.ffmpegPath,
				buildSlateNormalizeArgs({
					sourcePath: srcPath,
					destPath,
					target,
					hasAudio: facts.hasAudio,
					interlaced: facts.interlaced,
				}),
				{ signal: AbortSignal.timeout(timeoutMs) },
			);
			if (result.code !== 0) {
				throw new PrepareError(
					`ffmpeg could not convert the file (exit ${result.code ?? "signal"}): ${stderrTail(result.stderr) || "no output"}`,
				);
			}
			await onProgress?.(
				`converted, uploading the MPEG-TS to ${out.bucket}/${out.key}`,
			)?.catch(() => {});
			await uploader.putObject({
				bucket: out.bucket,
				key: out.key,
				filePath: destPath,
				contentType: "video/mp2t",
			});
			return {
				kind: "READY",
				source: out,
				normalized: true,
				target,
				note: `converted to MPEG-TS ${target.width}x${target.height} ${slateFrameRateToken(target.frameRate)} fps, AAC ${target.sampleRate} Hz ${target.channels}ch to match the live input (${reasons.join(", ")}) → ${out.bucket}/${out.key}${
					target.channelsAssumed
						? "; channel count assumed stereo (the live input reports none)"
						: ""
				}`,
			};
		} catch (err) {
			const message = redactSecrets(
				err instanceof Error ? err.message : String(err),
			);
			return {
				kind: "REFUSED",
				reason:
					err instanceof PrepareError
						? message
						: `normalization failed: ${message}`,
			};
		} finally {
			browser?.dispose?.();
			if (uploader !== browser) {
				uploader?.dispose?.();
			}
			await rm(srcPath, { force: true }).catch(() => {});
			await rm(destPath, { force: true }).catch(() => {});
		}
	};
}
