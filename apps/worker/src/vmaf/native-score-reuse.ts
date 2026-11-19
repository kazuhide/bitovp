import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
	type LocalVmafExecution,
	localVmafExecutionSchema,
	NATIVE_OFFICIAL_REVISION,
	PSNR_MAX_DB,
} from "@bitovp/core";
import { z } from "zod";
import type { ProcessRunner } from "../feeder/supervisor";
import type { NativeLocalSelection } from "./local-selection";
import { inspectNativeDevice } from "./native-auto-device";
import type { NativeExpected } from "./native-contract";

type Candidate = {
	provenance: unknown;
	framesGzip: Uint8Array | null;
};

export type NativeScoreReuseContext = {
	organizationId: string;
	scoringVersion: number;
	selection: NativeLocalSelection;
	load?: (key: string) => Promise<Candidate | null>;
};

type VerifiedScoreIdentity = {
	key: string;
	lookupKey: string;
	decoderRuntimeSha256: string;
};

export type VerifiedNativeScore = VerifiedScoreIdentity & {
	receiptSha256: string;
};

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const decodedRuntimeProof = z
	.object({ schemaVersion: z.literal(1), sourceSha256: sha, sha256: sha })
	.strict();
const storedProof = z
	.object({
		version: z.literal(3),
		key: sha,
		lookupKey: sha,
		decoderRuntimeSha256: sha,
		receiptSha256: sha,
		payloadSha256: sha,
	})
	.strict();
const storedCandidate = z.object({
	verifiedNativeScore: storedProof,
	localExecution: localVmafExecutionSchema,
});

const storedFrames = z.array(
	z
		.object({
			frameNum: z.number().int().nonnegative().safe(),
			vmaf: z.number().min(0).max(110),
			psnr: z.number().min(0).max(PSNR_MAX_DB).optional(),
		})
		.strict(),
);

const MAX_REUSABLE_FRAME_JSON_BYTES = 16 * 1024 * 1024;

export async function probeNativeDecoderRuntime(
	deps: { runner: ProcessRunner; nativePath: string },
	sourceSha256: string,
	signal?: AbortSignal,
) {
	try {
		const runtime = await deps.runner.run(
			deps.nativePath,
			["--decoder-runtime"],
			{
				signal,
				abortKillAfterMs: 250,
			},
		);
		signal?.throwIfAborted();
		if (runtime.code !== 0) return undefined;
		const parsedRuntime = decodedRuntimeProof.parse(JSON.parse(runtime.stdout));
		return parsedRuntime.sourceSha256 === sourceSha256
			? parsedRuntime.sha256
			: undefined;
	} catch {
		signal?.throwIfAborted();
		return undefined;
	}
}

export function verifiedNativeScoreLookupKey(
	scope: NativeScoreReuseContext,
	expected: NativeExpected,
	threads: number,
	decodeThreads: number,
	inflightFrames: 1 | 2 | 4,
) {
	const { selection } = scope;
	if (
		selection.backend !== expected.backend ||
		selection.device !== expected.device ||
		selection.identity.sourceSha256 !== expected.sourceSha256
	)
		return undefined;
	const { width, height, bitdepth } = expected.distortedOriginal;
	const { identity } = selection;
	// Only static facts select a candidate. Acceptance requires live runtime
	// evidence after its frame payload and stored evidence have been checked.
	return createHash("sha256")
		.update(
			JSON.stringify([
				"bitovp-native-vmaf-full-pair-lookup-v1",
				scope.organizationId,
				scope.scoringVersion,
				expected.referenceSha256,
				expected.distortedSha256,
				expected.model,
				expected.modelSha256,
				expected.width,
				expected.height,
				expected.bitDepth,
				width,
				height,
				bitdepth,
				expected.frameCount ?? null,
				expected.psnr,
				threads,
				decodeThreads,
				inflightFrames,
				selection.backend,
				selection.device,
				NATIVE_OFFICIAL_REVISION,
				identity.sourceSha256,
				identity.binarySha256,
				identity.supervisorBinarySha256,
				identity.deviceUuid,
			]),
		)
		.digest("hex");
}

function bindRuntime(
	lookupKey: string,
	decoderRuntimeSha256: string,
	device: {
		vendorId: number;
		deviceId: number;
		driverVersion: string;
		driverVersionSource: string;
	},
): VerifiedScoreIdentity {
	const key = createHash("sha256")
		.update(
			JSON.stringify([
				"bitovp-native-vmaf-full-pair-v3",
				lookupKey,
				decoderRuntimeSha256,
				device.vendorId,
				device.deviceId,
				device.driverVersion,
				device.driverVersionSource,
			]),
		)
		.digest("hex");
	return { key, lookupKey, decoderRuntimeSha256 };
}

export async function reconfirmNativeScore(
	deps: { runner: ProcessRunner; nativePath: string },
	scope: NativeScoreReuseContext,
	proof: VerifiedNativeScore,
	inflightFrames: 1 | 2 | 4,
	signal?: AbortSignal,
): Promise<boolean> {
	try {
		const { selection } = scope;
		const { info, cacheable } = await inspectNativeDevice(
			deps,
			{ ...selection, attestDecoderRuntime: true },
			signal,
		);
		const { identity } = selection;
		if (
			!cacheable ||
			!info.capabilities.processSupervisor ||
			!info.capabilities.inflightFrames.includes(inflightFrames) ||
			info.sourceSha256 !== identity.sourceSha256 ||
			info.binarySha256 !== identity.binarySha256 ||
			info.capabilities.supervisorBinarySha256 !==
				identity.supervisorBinarySha256 ||
			info.device.uuid !== identity.deviceUuid ||
			info.decoderRuntimeSha256 !== proof.decoderRuntimeSha256
		)
			return false;
		return (
			bindRuntime(proof.lookupKey, info.decoderRuntimeSha256, info.device)
				.key === proof.key
		);
	} catch {
		signal?.throwIfAborted();
		return false;
	}
}

const runtimeDriver = z
	.object({
		driverVersion: z.string().min(1).max(1024),
		driverVersionSource: z.string().min(1).max(128),
	})
	.strict();

export function completedNativeScoreIdentity(
	lookupKey: string,
	decoderRuntimeSha256: string,
	device: { vendorId: number; deviceId: number },
	evidence: unknown,
): VerifiedScoreIdentity | undefined {
	const driver = runtimeDriver.safeParse(evidence);
	if (!driver.success) return undefined;
	return bindRuntime(lookupKey, decoderRuntimeSha256, {
		...device,
		...driver.data,
	});
}

export function sealVerifiedNativeScore(
	proof: VerifiedNativeScore,
	execution: LocalVmafExecution,
	framesGzip: Uint8Array,
) {
	// The worker writes this record only after verifying the native receipt.
	// Bind that receipt's hash, the displayed execution evidence, and the
	// exact bounded frame payload together in the same result row.
	const evidence = localVmafExecutionSchema.parse(execution);
	const payloadSha256 = createHash("sha256")
		.update(
			JSON.stringify([
				3,
				proof.key,
				proof.lookupKey,
				proof.decoderRuntimeSha256,
				proof.receiptSha256,
				evidence,
			]),
		)
		.update(framesGzip)
		.digest("hex");
	return { ...proof, version: 3 as const, payloadSha256 };
}

export async function readVerifiedNativeScore(
	load: NonNullable<NativeScoreReuseContext["load"]>,
	lookupKey: string,
	expected: NativeExpected,
	deviceUuid: string,
	signal?: AbortSignal,
) {
	try {
		const candidate = await load(lookupKey);
		signal?.throwIfAborted();
		if (!candidate?.framesGzip) return undefined;
		const { framesGzip } = candidate;
		if (framesGzip.byteLength > MAX_REUSABLE_FRAME_JSON_BYTES) return undefined;
		const { verifiedNativeScore: proof, localExecution: execution } =
			storedCandidate.parse(candidate.provenance);
		const { scoring } = execution;
		if (
			proof.lookupKey !== lookupKey ||
			execution.reusedVerifiedResult ||
			scoring.implementation !== "bitovp-owned" ||
			execution.attempts !== 1 ||
			execution.requestedDecode !== "cpu" ||
			execution.decode.reference.backend !== "cpu" ||
			execution.decode.distorted.backend !== "cpu" ||
			scoring.backend !== expected.backend ||
			scoring.model !== expected.model ||
			scoring.modelSha256 !== expected.modelSha256 ||
			scoring.sourceSha256 !== expected.sourceSha256 ||
			scoring.device.index !== expected.device ||
			scoring.device.uuid !== deviceUuid ||
			scoring.bitDepth !== expected.bitDepth ||
			scoring.distortedOriginal.width !== expected.distortedOriginal.width ||
			scoring.distortedOriginal.height !== expected.distortedOriginal.height ||
			scoring.distortedOriginal.bitdepth !==
				expected.distortedOriginal.bitdepth ||
			sealVerifiedNativeScore(proof, execution, framesGzip).payloadSha256 !==
				proof.payloadSha256
		)
			return undefined;
		const frames = storedFrames.parse(
			JSON.parse(
				gunzipSync(framesGzip, {
					maxOutputLength: MAX_REUSABLE_FRAME_JSON_BYTES,
				}).toString("utf8"),
			),
		);
		if (
			frames.length === 0 ||
			(expected.frameCount !== undefined &&
				frames.length !== expected.frameCount) ||
			frames.length !== scoring.cpuParity.scoreCount ||
			scoring.features.length !== 7 ||
			frames.length * scoring.features.length !==
				scoring.cpuParity.featureCount ||
			frames.some(
				(frame, index) =>
					frame.frameNum !== index ||
					(frame.psnr !== undefined) !== expected.psnr,
			)
		)
			return undefined;
		signal?.throwIfAborted();
		return {
			execution: { ...execution, reusedVerifiedResult: true as const },
			verifiedNativeScore: {
				key: proof.key,
				lookupKey,
				decoderRuntimeSha256: proof.decoderRuntimeSha256,
				receiptSha256: proof.receiptSha256,
			},
			log: {
				frames: frames.map(({ frameNum, vmaf, psnr }) => ({
					frameNum,
					metrics: { vmaf, ...(psnr !== undefined ? { psnr_y: psnr } : {}) },
				})),
			},
		};
	} catch {
		signal?.throwIfAborted();
		// A deleted, unreadable or damaged predecessor is just a cache miss.
		return undefined;
	}
}
