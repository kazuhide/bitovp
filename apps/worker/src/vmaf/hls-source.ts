import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	type HlsQcEvidence,
	type HlsQcTarget,
	hlsQcEvidenceSchema,
	type QcTarget,
	retainedHlsQcKey,
} from "@bitovp/core";
import {
	type BrowserCredential,
	createBrowserForCredential,
	type ObjectStorageBrowser,
} from "@bitovp/storage";
import {
	parseEditingHlsPlaylist,
	resolveEditingHlsKey,
} from "../library-editing/hls-source";
import { downloadPinnedEditingMedia } from "../library-editing/media";
import type { ResolvedCredential } from "../orchestrator/executor";
import type { DownloadProvenance } from "./download";

const LIMITS = Object.freeze({
	playlistBytes: 1024 * 1024,
	segments: 4096,
	bytes: 8 * 1024 ** 3,
	timeoutMs: 20 * 60 * 1000,
});
const fail = (reason: string): never => {
	throw new Error(`HLS_QC_${reason}`);
};
const missing = (error: unknown) => {
	if (!error || typeof error !== "object") return false;
	const e = error as {
		name?: string;
		$metadata?: { httpStatusCode?: number };
		statusCode?: number;
	};
	return (
		e.$metadata?.httpStatusCode === 404 ||
		e.statusCode === 404 ||
		e.name === "NoSuchKey" ||
		e.name === "NotFound"
	);
};
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const stop = () => reject(signal.reason ?? new Error("HLS_QC_CANCELED"));
		signal.addEventListener("abort", stop, { once: true });
		pending.then(
			(value) => {
				signal.removeEventListener("abort", stop);
				signal.aborted ? stop() : resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", stop);
				reject(error);
			},
		);
		if (signal.aborted) stop();
	});
}

/** Capture only plan-bound storage objects and retain their exact fMP4 bytes.
 * No playlist URI reaches FFmpeg, no delivery object is rewritten, and no
 * existing retained object is overwritten. The caller owns resource admission
 * and validates decoded HDR/frame coverage before committing the result. */
export async function acquireHlsQcOutput(input: {
	target: HlsQcTarget;
	vmafJobId: string;
	bucket: string;
	jobDir: string;
	credential?: ResolvedCredential;
	browser?: ObjectStorageBrowser;
	signal?: AbortSignal;
}): Promise<{
	path: string;
	provenance: DownloadProvenance;
	hlsSource: HlsQcEvidence;
	target: QcTarget;
}> {
	input.signal?.throwIfAborted();
	if (!/^[A-Za-z0-9_-]+$/.test(input.target.renditionKey))
		return fail("IDENTITY_INVALID");
	const signal = AbortSignal.any([
		AbortSignal.timeout(LIMITS.timeoutMs),
		...(input.signal ? [input.signal] : []),
	]);
	const browser =
		input.browser ??
		(input.credential
			? createBrowserForCredential({
					provider: input.credential.provider as BrowserCredential["provider"],
					config: input.credential.config,
					secret: input.credential.secret,
				})
			: fail("CREDENTIAL_REQUIRED"));
	let scratch: string | undefined;
	const outputPath = join(input.jobDir, `hls-${input.target.renditionKey}.mp4`);
	let ownedOutput = false,
		complete = false,
		totalBytes = 0;
	const objects: HlsQcEvidence["objects"] = [];
	try {
		scratch = await mkdtemp(join(input.jobDir, "hls-qc-"));
		const ownedScratch = scratch;
		if (!browser.headObject || !browser.getObject || !browser.putObject)
			fail("STORAGE_CAPABILITY_REQUIRED");
		const headObject = browser.headObject?.bind(browser);
		const putObject = browser.putObject?.bind(browser);
		if (!headObject || !putObject) return fail("STORAGE_CAPABILITY_REQUIRED");
		const capture = async (
			key: string,
			role: HlsQcEvidence["objects"][number]["role"],
		) => {
			signal.throwIfAborted();
			if (objects.some((item) => item.key === key)) fail("DUPLICATE_OBJECT");
			const path = join(ownedScratch, `object-${objects.length}`);
			const captured = await downloadPinnedEditingMedia({
				browser,
				bucket: input.bucket,
				key,
				destinationPath: path,
				maxBytes: Math.min(
					LIMITS.bytes - totalBytes,
					role === "MASTER" || role === "MEDIA"
						? LIMITS.playlistBytes
						: LIMITS.bytes,
				),
				signal,
				timeoutMs: LIMITS.timeoutMs,
			});
			totalBytes += captured.bytes;
			objects.push({
				role,
				key,
				bytes: captured.bytes,
				sha256: captured.sha256,
				identity: captured.identity,
			});
			return path;
		};
		const playlist = async (key: string, role: "MASTER" | "MEDIA") => {
			const path = await capture(key, role);
			let text: string;
			try {
				text = new TextDecoder("utf-8", { fatal: true }).decode(
					await readFile(path),
				);
			} catch {
				return fail("PLAYLIST_ENCODING");
			}
			return parseEditingHlsPlaylist(text);
		};
		const masterKey = input.target.distorted.path;
		const master = await playlist(masterKey, "MASTER");
		if (master.kind !== "MASTER" || master.variants.length !== 1)
			return fail("AMBIGUOUS_MASTER");
		const variant = master.variants[0];
		const videoCodec = {
			AV1: /^av01\./i,
			H265: /^(hvc1|hev1)\./i,
			H264: /^(avc1|avc3)\./i,
			VP9: /^vp09\./i,
		}[input.target.codec];
		if (
			!variant ||
			!["PQ", "HLG"].includes(variant.videoRange ?? "") ||
			variant.height !== input.target.height ||
			!variant.codecs?.split(",").some((codec) => videoCodec.test(codec.trim()))
		)
			return fail("DECLARED_PROFILE");
		const mediaKey = resolveEditingHlsKey(
			masterKey,
			variant.uri,
			input.target.hls.rootPrefix,
		);
		for (const audio of master.audio)
			if (audio.uri)
				resolveEditingHlsKey(masterKey, audio.uri, input.target.hls.rootPrefix);
		const media = await playlist(mediaKey, "MEDIA");
		if (
			media.kind !== "MEDIA" ||
			!media.initUri ||
			media.segments.length > LIMITS.segments
		)
			return fail("FMP4_REQUIRED");
		const initKey = resolveEditingHlsKey(
			mediaKey,
			media.initUri,
			input.target.hls.rootPrefix,
		);
		if (initKey !== input.target.hls.initKey) return fail("INIT_BINDING");
		const parts = input.target.hls.segmentNaming.split("%number%");
		if (parts.length !== 2) return fail("SEGMENT_NAMING");
		let previousNumber: bigint | undefined;
		const segmentKeys = media.segments.map((segment) => {
			const key = resolveEditingHlsKey(
				mediaKey,
				segment.uri,
				input.target.hls.rootPrefix,
			);
			if (!key.startsWith(input.target.hls.outputPrefix))
				return fail("SEGMENT_BINDING");
			const filename = key.slice(input.target.hls.outputPrefix.length),
				before = parts[0] ?? "",
				after = parts[1] ?? "";
			if (!filename.startsWith(before) || !filename.endsWith(after))
				return fail("SEGMENT_BINDING");
			const number = filename.slice(
				before.length,
				after.length ? -after.length : undefined,
			);
			if (!/^\d{1,12}$/.test(number)) return fail("SEGMENT_NUMBER");
			const value = BigInt(number);
			if (previousNumber !== undefined && value !== previousNumber + 1n)
				return fail("SEGMENT_SEQUENCE");
			previousNumber = value;
			return key;
		});
		if (new Set(segmentKeys).size !== segmentKeys.length)
			return fail("DUPLICATE_OBJECT");
		const init = await capture(initKey, "INIT");
		const output = await open(outputPath, "wx", 0o600);
		ownedOutput = true;
		const hash = createHash("sha256");
		let assembledBytes = 0;
		const append = async (path: string) => {
			for await (const chunk of createReadStream(path, { signal })) {
				signal.throwIfAborted();
				hash.update(chunk);
				assembledBytes += chunk.length;
				if (assembledBytes > LIMITS.bytes) fail("BYTE_LIMIT");
				await output.writeFile(chunk);
			}
		};
		try {
			await append(init);
			for (const key of segmentKeys)
				await append(await capture(key, "SEGMENT"));
		} finally {
			await output.close();
		}
		const assembledSha256 = hash.digest("hex");
		const retainedKey = retainedHlsQcKey(
			input.target,
			input.vmafJobId,
			assembledSha256,
		);
		const hlsSource = hlsQcEvidenceSchema.parse({
			version: 1,
			method: "FMP4_INIT_SEGMENTS",
			vmafJobId: input.vmafJobId,
			renditionKey: input.target.renditionKey,
			muxingKey: input.target.hls.muxingKey,
			bucket: input.bucket,
			masterKey,
			mediaKey,
			objects,
			segmentCount: segmentKeys.length,
			durationSeconds: media.durationSeconds,
			assembledSha256,
			assembledBytes,
			complete: true,
		});
		signal.throwIfAborted();
		let existing = false;
		try {
			await abortable(
				headObject({ bucket: input.bucket, key: retainedKey }),
				signal,
			);
			existing = true;
		} catch (error) {
			if (!missing(error)) throw error;
		}
		if (!existing)
			await abortable(
				putObject({
					bucket: input.bucket,
					key: retainedKey,
					filePath: outputPath,
					contentType: "video/mp4",
					signal,
					timeoutMs: LIMITS.timeoutMs,
				}),
				signal,
			);
		const retained = await downloadPinnedEditingMedia({
			browser,
			bucket: input.bucket,
			key: retainedKey,
			destinationPath: join(ownedScratch, "retained-check.mp4"),
			expectedSha256: assembledSha256,
			maxBytes: assembledBytes,
			signal,
			timeoutMs: LIMITS.timeoutMs,
		});
		if (retained.bytes !== assembledBytes) fail("RETAINED_BYTES_MISMATCH");
		signal.throwIfAborted();
		complete = true;
		return {
			path: outputPath,
			provenance: {
				bucket: input.bucket,
				key: retainedKey,
				identity: retained.identity,
				pinned: true,
				sha256: assembledSha256,
				bytes: assembledBytes,
			},
			hlsSource,
			target: {
				...input.target,
				distorted: {
					outputKey: input.target.distorted.outputKey,
					path: retainedKey,
				},
			},
		};
	} finally {
		if (scratch) await rm(scratch, { recursive: true, force: true });
		if (ownedOutput && !complete) await rm(outputPath, { force: true });
		if (!input.browser) browser.dispose?.();
	}
}
