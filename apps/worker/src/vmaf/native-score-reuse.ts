import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
	type LocalVmafExecution,
	localVmafExecutionSchema,
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

export type VerifiedNativeScore = {
	key: string;
	receiptSha256: string;
};

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const storedProof = z
	.object({
		version: z.literal(1),
		key: sha,
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

export async function verifiedNativeScoreKey(
	deps: { runner: ProcessRunner; nativePath: string },
	scope: NativeScoreReuseContext,
	expected: NativeExpected,
	threads: number,
	decodeThreads: number,
	inflightFrames: 1 | 2 | 4,
	signal?: AbortSignal,
) {
	const { selection } = scope;
	if (
		selection.backend !== expected.backend ||
		selection.device !== expected.device ||
		selection.identity.sourceSha256 !== expected.sourceSha256
	)
		return undefined;
	try {
		const { info, cacheable } = await inspectNativeDevice(
			deps,
			selection,
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
			info.device.uuid !== identity.deviceUuid
		)
			return undefined;
		const { width, height, bitdepth } = expected.distortedOriginal;
		// Both inputs are already materialized and hashed. The native route
		// rejects extra transforms and always decodes on the CPU here.
		return createHash("sha256")
			.update(
				JSON.stringify([
					"bitovp-native-vmaf-full-pair-v1",
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
					info.backend,
					info.officialSourceRevision,
					info.sourceSha256,
					info.binarySha256,
					info.capabilities.supervisorBinarySha256,
					info.device.index,
					info.device.uuid,
					info.device.vendorId,
					info.device.deviceId,
					info.device.driverVersion,
					info.device.driverVersionSource,
				]),
			)
			.digest("hex");
	} catch {
		signal?.throwIfAborted();
		// Missing or unknown runtime identity disables reuse for this pair.
		return undefined;
	}
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
		.update(JSON.stringify([1, proof.key, proof.receiptSha256, evidence]))
		.update(framesGzip)
		.digest("hex");
	return { version: 1 as const, ...proof, payloadSha256 };
}

export async function readVerifiedNativeScore(
	load: NonNullable<NativeScoreReuseContext["load"]>,
	key: string,
	expected: NativeExpected,
	deviceUuid: string,
	signal?: AbortSignal,
) {
	try {
		const candidate = await load(key);
		signal?.throwIfAborted();
		if (!candidate?.framesGzip) return undefined;
		const { framesGzip } = candidate;
		if (framesGzip.byteLength > MAX_REUSABLE_FRAME_JSON_BYTES) return undefined;
		const { verifiedNativeScore: proof, localExecution: execution } =
			storedCandidate.parse(candidate.provenance);
		const { scoring } = execution;
		if (
			proof.key !== key ||
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
