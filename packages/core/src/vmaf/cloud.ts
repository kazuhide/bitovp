import { z } from "zod";
import type { VmafReferenceGeometry } from "./command";

const key = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
// Profiles are readable configuration: SAS tokens and URL userinfo belong in
// the encrypted vault, never in a config snapshot or the browser response.
const serviceUrl = z.url().refine((value) => {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash
		);
	} catch {
		return false;
	}
}, "Expected an HTTPS service URL without credentials, query, or fragment");
const base = {
	computeCredentialId: z.uuid().optional(),
	stagingCredentialId: z.uuid().optional(),
	profileVersion: z.number().int().positive().optional(),
	id: key,
	label: z.string().min(1).max(100),
	image: z
		.string()
		.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/)
		.refine(
			(value) => !value.includes("://"),
			"Expected a digest-pinned container image reference",
		),
	region: key,
	cpu: z.number().int().min(1).max(96),
	memoryMiB: z.number().int().min(1024).max(786432),
	diskGiB: z.number().int().min(10).max(4096),
	maxParallel: z.number().int().min(1).max(100),
	timeoutSeconds: z.number().int().min(60).max(86400),
	queueTimeoutSeconds: z.number().int().min(60).max(7200),
	// Operator-supplied conservative ceiling including pool idle/overshoot.
	maxCostUsdPerHour: z.number().positive().max(10000),
	transferUsdPerGiB: z.number().nonnegative().max(100),
	overheadUsd: z.number().nonnegative().max(10000),
	maxStagingGiB: z.number().positive().max(8192),
	staging: z.discriminatedUnion("provider", [
		z
			.object({
				provider: z.literal("S3"),
				bucket: z.string().min(1),
				region: key,
				endpoint: serviceUrl.optional(),
			})
			.strict(),
		z
			.object({ provider: z.literal("GCS"), bucket: z.string().min(1) })
			.strict(),
		z
			.object({
				provider: z.literal("AZURE"),
				accountUrl: serviceUrl,
				container: key,
			})
			.strict(),
	]),
};
export const vmafCloudProfileSchema = z.discriminatedUnion("provider", [
	z
		.object({
			...base,
			provider: z.literal("AWS_BATCH"),
			jobQueue: z.string().min(1),
			jobDefinition: z.string().min(1),
		})
		.strict(),
	z
		.object({
			...base,
			provider: z.literal("GCP_BATCH"),
			project: key,
			machineType: key,
			serviceAccount: z.email(),
			spot: z.boolean().default(true),
			spotPolicy: z
				.object({
					maxRetries: z.number().int().min(0).max(5),
					deadlineSeconds: z.number().int().min(60).max(86400),
				})
				.strict()
				.optional(),
		})
		.strict(),
	z
		.object({
			...base,
			provider: z.literal("AZURE_BATCH"),
			accountUrl: serviceUrl,
			poolId: key,
			spot: z.boolean().default(false),
		})
		.strict(),
	z
		.object({
			...base,
			provider: z.literal("AKAMAI_VM"),
			instanceType: key,
			bootImage: z.string().min(1),
			reaperEnabled: z.literal(true),
		})
		.strict(),
]);
export type VmafCloudProfile = z.infer<typeof vmafCloudProfileSchema>;

/**
 * SVAT's standard/high definitions and HD OOM notes establish the SD/HD tiers.
 * Its XL definition supplies a conservative UHD tier, not a measured minimum.
 * Legacy manual fields remain readable for durable cleanup of older tasks;
 * every new task replaces them after probing its reference and input sizes.
 */
export function automaticVmafProfile(
	profile: VmafCloudProfile,
	input: { width?: number; height?: number; bytes?: number } = {},
): VmafCloudProfile {
	if (
		input.bytes !== undefined &&
		(!Number.isFinite(input.bytes) || input.bytes < 0)
	)
		throw new Error("Invalid VMAF input size");
	const pixels = (input.width ?? 1920) * (input.height ?? 1080);
	if (!Number.isFinite(pixels) || pixels <= 0)
		throw new Error("Invalid VMAF reference dimensions");
	const cpu = pixels <= 720 * 576 ? 4 : pixels <= 1920 * 1080 ? 8 : 16;
	return vmafCloudProfileSchema.parse({
		...profile,
		cpu,
		memoryMiB: cpu === 4 ? 8192 : cpu * 4096,
		diskGiB:
			input.bytes === undefined
				? 500
				: Math.max(50, Math.ceil((input.bytes / 1024 ** 3) * 1.2 + 20)),
		// Compatibility value only. Scheduling uses the selected report Pair count.
		maxParallel: 100,
		...(profile.provider === "GCP_BATCH"
			? {
					machineType: cpu === 4 ? "n2-standard-4" : `n2-standard-${cpu}`,
				}
			: {}),
		...(profile.provider === "AKAMAI_VM" ? { instanceType: "auto" } : {}),
	});
}
export const vmafCloudProfilesSchema = z
	.array(vmafCloudProfileSchema)
	.max(20)
	.refine(
		(p) => new Set(p.map((x) => x.id)).size === p.length,
		"Duplicate compute profile ID",
	);
export const vmafExecutionSchema = z.discriminatedUnion("backend", [
	z.object({ backend: z.literal("LOCAL") }).strict(),
	z
		.object({
			backend: z.literal("CLOUD"),
			profileId: key,
			budgetUsd: z.number().positive().max(100000),
		})
		.strict(),
]);
export type VmafExecution = z.infer<typeof vmafExecutionSchema>;
export function parseVmafCloudProfiles(
	raw: string | undefined,
): VmafCloudProfile[] {
	return raw ? vmafCloudProfilesSchema.parse(JSON.parse(raw)) : [];
}

export type CloudLaunch = {
	taskId: string;
	manifestUrl: string;
	deadline: string;
};
export type CloudTaskState =
	| "QUEUED"
	| "RUNNING"
	| "SUCCEEDED"
	| "FAILED"
	| "MISSING";
export interface VmafComputeAdapter {
	submit(launch: CloudLaunch): Promise<string>;
	// Resolve an ambiguous create without submitting a second paid task.
	find(taskId: string): Promise<string | undefined>;
	status(providerId: string): Promise<CloudTaskState>;
	failureReason?(
		providerId: string,
	): Promise<"PREEMPTED" | "CAPACITY" | "OTHER">;
	cancel(providerId: string): Promise<void>;
	cleanup(providerId: string): Promise<void>;
}
export type SignedTransfer = { url: string; headers?: Record<string, string> };
export interface VmafStagingStore {
	upload(key: string, path: string, signal?: AbortSignal): Promise<void>;
	download(key: string, path: string): Promise<void>;
	signedRead(key: string, expiresSeconds: number): Promise<string>;
	signedWrite(key: string, expiresSeconds: number): Promise<SignedTransfer>;
	remove(keys: string[]): Promise<void>;
}
export type VmafCloudManifest = {
	version: 1;
	taskId: string;
	deadline: string;
	image: string;
	reference: { url: string; sha256: string; bytes: number };
	distorted: { url: string; sha256: string; bytes: number };
	modelFile?: { url: string; sha256: string; bytes: number };
	// JSON-safe VmafCommandOptions excluding local paths; existing scoring semantics.
	scoring: {
		model: string;
		scaleToReference?: { width: number; height: number };
		fpsConform?: number;
		measurementMethod?: "FRAME_INDEX_BT709_10BIT";
		referenceFrameRate?: string;
		distortedOriginal?: { width: number; height: number; bitdepth: number };
		referenceGeometry?: VmafReferenceGeometry;
		threads?: number;
		subsample?: number;
		psnr?: boolean;
		features?: string[];
		alignFrames?: number;
	};
	progress?: SignedTransfer;
	checkpoint?: {
		authenticationKey: string;
		readUrl?: string;
		sha256?: string;
		write: SignedTransfer;
	};
	output: SignedTransfer;
	receipt: SignedTransfer;
};
export type VmafCloudReceipt = {
	version: 1;
	taskId: string;
	image: string;
	resultSha256: string;
	referenceSha256: string;
	distortedSha256: string;
	modelSha256?: string;
	frames: number;
	referenceFrames?: number;
	measurementMethod?: "FRAME_INDEX_BT709_10BIT";
	scoringVersion?: 5 | 6;
	cropPolicy?: "codec-only-ignore-container-aperture-v1";
	cadence?: Record<string, unknown>;
	ffmpegVersion: string;
	completedAt: string;
	startedAt?: string;
	coverageValidation?: {
		reused: boolean;
		taskId: string;
		completedAt: string;
		checkpointSha256: string;
	};
	timingsMs?: {
		download: number;
		coverage: number;
		scoring: number;
		resultUpload: number;
	};
};
