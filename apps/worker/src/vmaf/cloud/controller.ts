import {
	createHmac,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	automaticVmafProfile,
	frameIndexDisplayGeometry,
	parseVmafJson,
	sampleAspectRatioFromProbe,
	VMAF_FRAME_INDEX_CROP_POLICY,
	VMAF_FRAME_INDEX_SCORING_VERSION,
	type VmafCloudManifest,
	type VmafCloudProfile,
	type VmafCloudReceipt,
	type VmafCommandOptions,
	type VmafComputeAdapter,
	type VmafReferenceGeometry,
	type VmafStagingStore,
	vmafCloudProfileSchema,
} from "@bitovp/core";
import {
	type AppPrismaClient,
	DB_NULL,
	type Prisma,
	tenantOrganizationId,
	type VmafComputeTask,
} from "@bitovp/db";
import { verifiedFileIdentity as fileIdentity } from "../file-identity";
import type { AwsDependencies } from "./provider-aws";
import { createComputeAdapter } from "./providers";
import {
	type CloudRemoteInput,
	validateCloudRemoteInput,
} from "./remote-input";
import type { StagingDependencies } from "./staging";
import { createStagingStore, StagingNotFoundError } from "./staging";

export type CloudScoreRequest = {
	vmafJobId: string;
	targetKey: string;
	/** Actual eligible pair population enumerated by the report processor. */
	pairCount: number;
	profileId: string;
	profile?: VmafCloudProfile;
	budgetUsd: number;
	options: VmafCommandOptions;
	/** Server-signed existing objects; caller cannot supply arbitrary URLs. */
	remoteInputs?: { reference?: CloudRemoteInput; distorted?: CloudRemoteInput };
	signal: AbortSignal;
};

export { verifiedFileIdentity as fileIdentity } from "../file-identity";

/** Historical generation-5 tasks remain collectable; new generation-6 jobs
 * must prove the codec-only decode policy instead of accepting old images. */
export function receiptMatchesMeasurement(
	receipt: VmafCloudReceipt,
	method: VmafCommandOptions["measurementMethod"],
	generation: number | undefined,
	referenceGeometry?: VmafReferenceGeometry,
): boolean {
	if (!method) return referenceGeometry === undefined;
	if (
		receipt.measurementMethod !== method ||
		receipt.scoringVersion !== generation
	)
		return false;
	if (referenceGeometry) {
		try {
			const expected = frameIndexDisplayGeometry(referenceGeometry);
			const reference = receipt.cadence?.reference as
				| Record<string, unknown>
				| undefined;
			const display = receipt.cadence?.displayGeometry as
				| Record<string, unknown>
				| undefined;
			if (
				reference?.width !== referenceGeometry.width ||
				reference?.height !== referenceGeometry.height ||
				reference?.sampleAspectRatioPolicy !== "reported" ||
				sampleAspectRatioFromProbe(reference?.sampleAspectRatio) !==
					sampleAspectRatioFromProbe(referenceGeometry.sampleAspectRatio) ||
				display?.policy !== "sample-aspect-ratio-display-v1" ||
				display.width !== expected.width ||
				display.height !== expected.height
			)
				return false;
		} catch {
			return false;
		}
	}
	return (
		generation === 5 ||
		(generation === VMAF_FRAME_INDEX_SCORING_VERSION &&
			receipt.cropPolicy === VMAF_FRAME_INDEX_CROP_POLICY)
	);
}

export function reserveCost(profile: VmafCloudProfile, bytes: number): number {
	const gib = bytes / 1024 ** 3;
	if (gib > profile.maxStagingGiB || gib * 1.2 + 2 > profile.diskGiB) {
		throw new Error("VMAF inputs exceed compute profile storage capacity");
	}
	return (
		Math.ceil(
			((profile.maxCostUsdPerHour *
				(profile.timeoutSeconds + profile.queueTimeoutSeconds)) /
				3600 +
				gib * profile.transferUsdPerGiB +
				profile.overheadUsd) *
				100,
		) / 100
	);
}

function canonicalCheckpoint(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalCheckpoint);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([key, item]) => [key, canonicalCheckpoint(item)]),
		);
	return value;
}
class ComputeCapacityBusy extends Error {}
class RecoverableSpotFailure extends Error {
	constructor(
		readonly reason: "PREEMPTED" | "CAPACITY" | "SPOT_DEADLINE",
		readonly taskId: string,
	) {
		super(reason);
	}
}
type RecoveryContext = {
	attempt: number;
	spotDeadline: Date;
	checkpointPath: string;
	authenticationKey: string;
	producerTaskIds: Set<string>;
	transitionReason?: string;
};
const progressPhases = new Set([
	"MANIFEST",
	"REFERENCE_DOWNLOAD",
	"DISTORTED_DOWNLOAD",
	"MODEL_DOWNLOAD",
	"REFERENCE_PROBE",
	"DISTORTED_PROBE",
	"ALIGNMENT",
	"SCORING",
	"RESULT_UPLOAD",
	"RECEIPT_UPLOAD",
]);

type Deps = {
	prisma: AppPrismaClient;
	profiles?: VmafCloudProfile[];
	resolveProfile?: (id: string) => Promise<VmafCloudProfile | undefined>;
	computeAuth?: (profile: VmafCloudProfile) => Promise<AwsDependencies>;
	stagingAuth?: (profile: VmafCloudProfile) => Promise<StagingDependencies>;
	workDir: string;
	adapter?: (profile: VmafCloudProfile) => VmafComputeAdapter;
	store?: (profile: VmafCloudProfile["staging"]) => VmafStagingStore;
	now?: () => Date;
	pollMs?: number;
	wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

export function createVmafCloudController(deps: Deps) {
	const { prisma } = deps;
	const now = deps.now ?? (() => new Date());
	const adapterFor = async (profile: VmafCloudProfile) => {
		try {
			return deps.adapter
				? deps.adapter(profile)
				: createComputeAdapter(profile, await deps.computeAuth?.(profile));
		} catch {
			throw new Error("VMAF compute credentials are unavailable");
		}
	};
	const storeFor = async (profile: VmafCloudProfile) => {
		try {
			return deps.store
				? deps.store(profile.staging)
				: createStagingStore(
						profile.staging,
						await deps.stagingAuth?.(profile),
					);
		} catch {
			throw new Error("VMAF staging credentials are unavailable");
		}
	};
	const resolveProfile = async (id: string) => {
		const value = deps.resolveProfile
			? await deps.resolveProfile(id)
			: deps.profiles?.find((p) => p.id === id);
		if (!value) throw new Error("VMAF compute profile is unavailable");
		const profile = vmafCloudProfileSchema.parse(value);
		if (profile.id !== id) throw new Error("VMAF compute profile mismatch");
		return profile;
	};
	const pollMs = deps.pollMs ?? 10_000;
	const wait =
		deps.wait ??
		((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }));
	const active = new Set<string>();

	async function update(id: string, data: Prisma.VmafComputeTaskUpdateInput) {
		return prisma.vmafComputeTask.update({ where: { id }, data });
	}

	/** No parent FK: reset must never erase ownership of billable resources. */
	async function cleanup(
		snapshot: VmafComputeTask,
		settled = false,
	): Promise<boolean> {
		let task = await prisma.vmafComputeTask.findUnique({
			where: { id: snapshot.id },
		});
		if (!task) return true;
		if (task.cleanedAt) {
			if (!settled || task.providerId) return true;
			// A resumed owner has definitive evidence its last upload settled.
			// Re-sweep even if a previous reaper cleaned an expired preparation.
			task = await update(task.id, {
				state: "CANCEL_PREPARING",
				cleanedAt: null,
			});
		}
		// The same CAS guards submit and pre-submit cleanup. A stale PREPARING
		// reader must never mark a SUBMITTING resource cleaned.
		if (task.state === "PREPARING") {
			const claim = await prisma.vmafComputeTask.updateMany({
				where: { id: task.id, state: "PREPARING", cleanedAt: null },
				data: { state: "CANCEL_PREPARING" },
			});
			if (claim.count !== 1) return false;
			task = { ...task, state: "CANCEL_PREPARING" };
		}
		if (
			task.state === "CANCEL_PREPARING" &&
			!settled &&
			now().getTime() < task.expiresAt.getTime() + 60_000
		)
			return false;
		const profile = vmafCloudProfileSchema.parse(task.profile);
		const adapter = await adapterFor(profile);
		let providerId = task.providerId;
		if (!providerId && task.state !== "CANCEL_PREPARING") {
			providerId = (await adapter.find(`ovp-vmaf-${task.id}`)) ?? null;
			if (!providerId) {
				// Absence following an ambiguous CREATE is not proof of no late resource.
				// Keep the durable intent visible and repeat inventory reconciliation.
				await update(task.id, { state: "SUBMIT_UNKNOWN" });
				return false;
			}
			await update(task.id, { providerId });
		}
		if (providerId) {
			const state = await adapter.status(providerId);
			if (state === "QUEUED" || state === "RUNNING") {
				await adapter.cancel(providerId);
				return false;
			}
			await adapter.cleanup(providerId);
		}
		const keys = task.stagingKeys;
		if (!Array.isArray(keys) || !keys.every((key) => typeof key === "string")) {
			throw new Error("Invalid VMAF staging ownership record");
		}
		await (await storeFor(profile)).remove(keys as string[]);
		await update(task.id, { state: "CLEANED", cleanedAt: now() });
		return true;
	}

	async function scoreOnce(
		request: CloudScoreRequest,
		recovery?: RecoveryContext,
	): Promise<void> {
		let profile = request.profile
			? vmafCloudProfileSchema.parse(request.profile)
			: await resolveProfile(request.profileId);
		if (profile.id !== request.profileId)
			throw new Error("VMAF compute profile mismatch");
		if ((request.options.subsample ?? 1) !== 1) {
			throw new Error("Cloud VMAF requires full-frame scoring (subsample=1)");
		}
		if (request.options.referenceGeometry) {
			const display = frameIndexDisplayGeometry(
				request.options.referenceGeometry,
			);
			if (
				request.options.measurementMethod !== "FRAME_INDEX_BT709_10BIT" ||
				display.width !== request.options.scaleToReference?.width ||
				display.height !== request.options.scaleToReference?.height
			)
				throw new Error("INPUT_GEOMETRY_CLAIM_MISMATCH");
		}
		if (!request.options.modelPath) {
			throw new Error(
				"Cloud VMAF requires a bundled model file to pin its hash",
			);
		}
		if (!Number.isSafeInteger(request.pairCount) || request.pairCount < 1)
			throw new Error("VMAF cloud pair count must be a positive integer");
		request.signal.throwIfAborted();
		const reference = await fileIdentity(request.options.referencePath);
		const distorted = await fileIdentity(request.options.distortedPath);
		const remote = request.remoteInputs;
		if (remote?.reference)
			validateCloudRemoteInput(remote.reference, reference);
		if (remote?.distorted)
			validateCloudRemoteInput(remote.distorted, distorted);
		const model = request.options.modelPath
			? await fileIdentity(request.options.modelPath)
			: undefined;
		const bytes = reference.bytes + distorted.bytes + (model?.bytes ?? 0);
		profile = automaticVmafProfile(profile, {
			...request.options.scaleToReference,
			bytes,
		});
		const store = await storeFor(profile);
		const adapter = await adapterFor(profile);
		const reservedUsd = reserveCost(profile, bytes);
		const id = randomUUID();
		recovery?.producerTaskIds.add(id);
		const organizationId = tenantOrganizationId(prisma);
		const prefix = organizationId
			? `bitovp-vmaf/${organizationId}/${id}`
			: `bitovp-vmaf/${id}`;
		const trackedRecovery = !!recovery;
		const isSpot = profile.provider === "GCP_BATCH" && profile.spot;
		const deadline = new Date(
			Math.min(
				now().getTime() +
					(profile.timeoutSeconds + profile.queueTimeoutSeconds) * 1000,
				isSpot && recovery ? recovery.spotDeadline.getTime() : Infinity,
			),
		);
		const keys = [
			...(trackedRecovery
				? ["progress.json", "checkpoint.json", "checkpoint-input.json"]
				: []),
			...(remote?.reference ? [] : ["reference"]),
			...(remote?.distorted ? [] : ["distorted"]),
			"manifest.json",
			"result.json",
			"receipt.json",
			...(model ? ["model.json"] : []),
		].map((k) => `${prefix}/${k}`);
		let task: VmafComputeTask;
		const admissionDeadline = Date.now() + profile.queueTimeoutSeconds * 1000;
		for (;;) {
			try {
				task = await prisma.$transaction(async (tx) => {
					// Serialise report capacity and budget reservations across workers.
					await tx.$executeRaw`SELECT pg_advisory_xact_lock(73921604)`;
					request.signal.throwIfAborted();
					const parent = await tx.vmafJob.findUnique({
						where: { id: request.vmafJobId },
						select: { status: true },
					});
					if (parent?.status !== "RUNNING")
						throw new Error("VMAF job is no longer active");
					const outstanding = await tx.vmafComputeTask.count({
						where: { vmafJobId: request.vmafJobId, cleanedAt: null },
					});
					if (outstanding >= request.pairCount)
						throw new ComputeCapacityBusy(
							"VMAF report pair capacity is occupied",
						);
					const spent = await tx.vmafComputeTask.aggregate({
						where: { vmafJobId: request.vmafJobId },
						_sum: { reservedUsd: true },
					});
					if ((spent._sum.reservedUsd ?? 0) + reservedUsd > request.budgetUsd) {
						throw new Error(
							"VMAF cloud budget is insufficient for another task",
						);
					}
					return tx.vmafComputeTask.create({
						data: {
							id,
							vmafJobId: request.vmafJobId,
							targetKey: request.targetKey,
							attempt: recovery?.attempt ?? 0,
							...(trackedRecovery
								? {
										progress: {
											phase: "STAGING",
											updatedAt: now().toISOString(),
											attempt: (recovery?.attempt ?? 0) + 1,
											provisioningModel: isSpot ? "SPOT" : "STANDARD",
											...(recovery?.transitionReason
												? { transitionReason: recovery.transitionReason }
												: {}),
										},
									}
								: {}),
							profileId: profile.id,
							profile: profile as Prisma.InputJsonValue,
							reservedUsd,
							stagingKeys: keys,
							expiresAt: deadline,
							queueExpiresAt: new Date(
								now().getTime() + profile.queueTimeoutSeconds * 1000,
							),
						},
					});
				});
				break;
			} catch (error) {
				if (
					!(error instanceof ComputeCapacityBusy) ||
					Date.now() >= admissionDeadline
				)
					throw error;
				await reconcile();
				await delay(pollMs, undefined, { signal: request.signal });
			}
		}
		active.add(id);
		const heartbeat = setInterval(() => {
			void update(id, { heartbeatAt: now() }).catch(() => undefined);
		}, 30_000);
		heartbeat.unref();
		const dir = join(deps.workDir, id);
		const uploadSignal = AbortSignal.any([
			request.signal,
			AbortSignal.timeout(
				Math.max(1, task.expiresAt.getTime() - now().getTime()),
			),
		]);
		let submitted = false;
		let terminalSuccessObserved = false;
		const stagingStart = performance.now();
		try {
			await mkdir(dir, { recursive: true });
			if (!remote?.reference)
				await store.upload(
					`${prefix}/reference`,
					request.options.referencePath,
					uploadSignal,
				);
			if (!remote?.distorted)
				await store.upload(
					`${prefix}/distorted`,
					request.options.distortedPath,
					uploadSignal,
				);
			if (request.options.modelPath)
				await store.upload(
					`${prefix}/model.json`,
					request.options.modelPath,
					uploadSignal,
				);
			request.signal.throwIfAborted();
			const ttl = profile.timeoutSeconds + profile.queueTimeoutSeconds + 900;
			const {
				referencePath: _r,
				distortedPath: _d,
				logPath: _l,
				modelPath: _m,
				...scoring
			} = request.options;
			let checkpointRead: { readUrl: string; sha256: string } | undefined;
			if (trackedRecovery && recovery) {
				try {
					if ((await stat(recovery.checkpointPath)).size <= 262144) {
						const identity = await fileIdentity(recovery.checkpointPath);
						await store.upload(
							`${prefix}/checkpoint-input.json`,
							recovery.checkpointPath,
							uploadSignal,
						);
						checkpointRead = {
							readUrl: await store.signedRead(
								`${prefix}/checkpoint-input.json`,
								ttl,
							),
							sha256: identity.sha256,
						};
					}
				} catch {
					/* Missing checkpoint is an ordinary first attempt. */
				}
			}
			const manifest: VmafCloudManifest = {
				...(trackedRecovery && recovery
					? {
							progress: await store.signedWrite(`${prefix}/progress.json`, ttl),
							checkpoint: {
								authenticationKey: recovery.authenticationKey,
								...checkpointRead,
								write: await store.signedWrite(
									`${prefix}/checkpoint.json`,
									ttl,
								),
							},
						}
					: {}),
				version: 1,
				taskId: id,
				deadline: task.expiresAt.toISOString(),
				image: profile.image,
				reference: {
					...reference,
					url:
						remote?.reference?.url ??
						(await store.signedRead(`${prefix}/reference`, ttl)),
				},
				distorted: {
					...distorted,
					url:
						remote?.distorted?.url ??
						(await store.signedRead(`${prefix}/distorted`, ttl)),
				},
				...(model
					? {
							modelFile: {
								...model,
								url: await store.signedRead(`${prefix}/model.json`, ttl),
							},
						}
					: {}),
				scoring: {
					...scoring,
					threads: profile.cpu,
				},
				output: await store.signedWrite(`${prefix}/result.json`, ttl),
				receipt: await store.signedWrite(`${prefix}/receipt.json`, ttl),
			};
			await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest), {
				mode: 0o600,
			});
			await store.upload(
				`${prefix}/manifest.json`,
				join(dir, "manifest.json"),
				uploadSignal,
			);
			await rm(join(dir, "manifest.json"));
			if (
				isSpot &&
				recovery &&
				recovery.spotDeadline.getTime() - now().getTime() < 60000
			)
				throw new RecoverableSpotFailure("SPOT_DEADLINE", id);
			if (now() >= task.queueExpiresAt)
				throw new Error("VMAF staging exceeded queue deadline");
			request.signal.throwIfAborted();
			const parent = await prisma.vmafJob.findUnique({
				where: { id: request.vmafJobId },
				select: { status: true },
			});
			if (parent?.status !== "RUNNING")
				throw new Error("VMAF job was reset before submission");
			const claim = await prisma.vmafComputeTask.updateMany({
				where: { id, state: "PREPARING", cleanedAt: null },
				data: { state: "SUBMITTING", heartbeatAt: now() },
			});
			if (claim.count !== 1) throw new Error("VMAF resource lease was revoked");
			submitted = true;
			const submittedAt = now().toISOString();
			const stagingMs = performance.now() - stagingStart;
			const providerId = await adapter.submit({
				taskId: `ovp-vmaf-${id}`,
				manifestUrl: await store.signedRead(`${prefix}/manifest.json`, ttl),
				deadline: task.expiresAt.toISOString(),
			});
			await update(id, {
				providerId,
				state: "QUEUED",
				cleanedAt: null,
				...(trackedRecovery
					? {
							progress: {
								phase: "QUEUED",
								updatedAt: now().toISOString(),
								attempt: (recovery?.attempt ?? 0) + 1,
								provisioningModel: isSpot ? "SPOT" : "STANDARD",
								...(recovery?.transitionReason
									? { transitionReason: recovery.transitionReason }
									: {}),
							},
						}
					: {}),
			});
			for (;;) {
				request.signal.throwIfAborted();
				if (now() >= task.expiresAt) {
					if (
						!terminalSuccessObserved &&
						isSpot &&
						recovery &&
						now() >= recovery.spotDeadline
					)
						throw new RecoverableSpotFailure("SPOT_DEADLINE", id);
					throw new Error("VMAF cloud task exceeded its deadline");
				}
				await update(id, { heartbeatAt: now() });
				const parent = await prisma.vmafJob.findUnique({
					where: { id: request.vmafJobId },
					select: { status: true, scoringVersion: true },
				});
				if (parent?.status !== "RUNNING")
					throw new Error("VMAF job was reset or stopped");
				if (trackedRecovery) {
					try {
						const path = join(dir, "progress.json");
						await store.download(`${prefix}/progress.json`, path);
						if ((await stat(path)).size <= 16384) {
							const p = JSON.parse(await readFile(path, "utf8"));
							const timestamp = Date.parse(p.updatedAt);
							if (
								p.version === 1 &&
								p.taskId === id &&
								p.image === profile.image &&
								progressPhases.has(p.phase) &&
								Number.isFinite(timestamp) &&
								timestamp <= now().getTime() + 60000
							) {
								const frames =
									Number.isSafeInteger(p.framesProcessed) &&
									p.framesProcessed >= 0 &&
									Number.isSafeInteger(p.totalFrames) &&
									p.totalFrames > 0 &&
									p.framesProcessed <= p.totalFrames;
								await update(id, {
									progress: {
										version: 1,
										phase: p.phase,
										updatedAt: p.updatedAt,
										attempt: (recovery?.attempt ?? 0) + 1,
										provisioningModel: isSpot ? "SPOT" : "STANDARD",
										...(frames
											? {
													framesProcessed: p.framesProcessed,
													totalFrames: p.totalFrames,
												}
											: {}),
										...(recovery?.transitionReason
											? { transitionReason: recovery.transitionReason }
											: {}),
									},
								});
							}
						}
					} catch {
						/* Telemetry never makes a valid measurement fail. */
					}
				}
				// Receipt wins over VM power state: Akamai shuts down after uploading.
				let receipt: VmafCloudReceipt | undefined;
				try {
					await store.download(
						`${prefix}/receipt.json`,
						join(dir, "receipt.json"),
					);
					receipt = JSON.parse(
						await readFile(join(dir, "receipt.json"), "utf8"),
					);
				} catch (err) {
					if (!(err instanceof StagingNotFoundError)) throw err;
				}
				if (receipt) {
					await store.download(
						`${prefix}/result.json`,
						request.options.logPath,
					);
					const result = await fileIdentity(request.options.logPath);
					const parsed = parseVmafJson(
						JSON.parse(await readFile(request.options.logPath, "utf8")),
					);
					if (
						!receiptMatchesMeasurement(
							receipt,
							request.options.measurementMethod,
							parent.scoringVersion,
							request.options.referenceGeometry,
						) ||
						receipt.version !== 1 ||
						receipt.taskId !== id ||
						receipt.image !== profile.image ||
						receipt.referenceSha256 !== reference.sha256 ||
						receipt.distortedSha256 !== distorted.sha256 ||
						receipt.modelSha256 !== model?.sha256 ||
						receipt.resultSha256 !== result.sha256 ||
						receipt.frames !== parsed.frames.length ||
						!parsed.frames.length ||
						receipt.referenceFrames !==
							receipt.frames + Math.max(0, request.options.alignFrames ?? 0) ||
						parsed.frames.some((frame, index) => frame.frameNum !== index)
					) {
						throw new Error(
							"VMAF cloud result identity or frame coverage is invalid",
						);
					}
					await update(id, {
						state: "SUCCEEDED",
						receipt: {
							...receipt,
							orchestration: {
								submittedAt,
								stagingMs,
								receivedAt: now().toISOString(),
							},
						} as unknown as Prisma.InputJsonValue,
					});
					return;
				}
				if (terminalSuccessObserved)
					throw new Error("VMAF compute ended without a valid result receipt");
				const status = await adapter.status(providerId);
				if (status === "SUCCEEDED") {
					// The receipt may have been uploaded after our preceding GET.
					// Re-read once through the unchanged receipt validation above.
					terminalSuccessObserved = true;
					continue;
				}
				if (status === "FAILED" || status === "MISSING") {
					if (status === "FAILED" && isSpot && recovery) {
						const reason = await adapter.failureReason?.(providerId);
						if (reason === "PREEMPTED" || reason === "CAPACITY")
							throw new RecoverableSpotFailure(reason, id);
					}
					throw new Error("VMAF compute ended without a valid result receipt");
				}
				if (status === "QUEUED" && now() >= task.queueExpiresAt) {
					if (
						isSpot &&
						recovery &&
						(await adapter.failureReason?.(providerId)) === "CAPACITY"
					)
						throw new RecoverableSpotFailure("CAPACITY", id);
					throw new Error("VMAF cloud queue deadline exceeded");
				}
				await update(id, { state: status });
				await delay(pollMs, undefined, { signal: request.signal });
			}
		} catch (caught) {
			const error =
				caught instanceof Error &&
				["AbortError", "TimeoutError"].includes(caught.name) &&
				!request.signal.aborted &&
				!terminalSuccessObserved &&
				isSpot &&
				recovery &&
				(!submitted ||
					!!(await prisma.vmafComputeTask.findUnique({ where: { id } }))
						?.providerId) &&
				now() >= recovery.spotDeadline
					? new RecoverableSpotFailure("SPOT_DEADLINE", id)
					: caught;
			if (error instanceof RecoverableSpotFailure && recovery) {
				try {
					const path = join(dir, "checkpoint.json");
					await store.download(`${prefix}/checkpoint.json`, path);
					if ((await stat(path)).size <= 262144) {
						const bytes = await readFile(path);
						const value = JSON.parse(bytes.toString("utf8"));
						const { authentication, ...payload } = value;
						const mac = createHmac(
							"sha256",
							Buffer.from(recovery.authenticationKey, "hex"),
						)
							.update(JSON.stringify(canonicalCheckpoint(payload)))
							.digest();
						if (
							typeof authentication === "string" &&
							/^[a-f0-9]{64}$/.test(authentication) &&
							recovery.producerTaskIds.has(value.taskId) &&
							timingSafeEqual(mac, Buffer.from(authentication, "hex"))
						)
							await writeFile(recovery.checkpointPath, bytes, { mode: 0o600 });
					}
				} catch {
					/* Incomplete coverage cannot be reused. */
				}
				await update(id, { error: error.reason });
				throw error;
			}
			await update(id, {
				error:
					"Cloud measurement failed; resource cleanup is tracked separately",
			});
			throw new Error(
				"Cloud VMAF did not finish; inspect compute task status and profile configuration",
			);
		} finally {
			clearInterval(heartbeat);
			active.delete(id);
			const latest = await prisma.vmafComputeTask.findUnique({ where: { id } });
			if (latest) {
				if (submitted) await update(id, { state: "CLEANUP_PENDING" });
				try {
					await cleanup(latest, true);
				} catch {
					/* Durable reaper retries. */
				}
			}
			await rm(dir, { recursive: true, force: true });
		}
	}

	async function score(request: CloudScoreRequest): Promise<void> {
		const profile = request.profile
			? vmafCloudProfileSchema.parse(request.profile)
			: await resolveProfile(request.profileId);
		if (
			profile.provider !== "GCP_BATCH" ||
			!profile.spot ||
			!profile.spotPolicy
		)
			return scoreOnce(request);
		const policy = profile.spotPolicy;
		const dir = join(deps.workDir, `recovery-${randomUUID()}`);
		await mkdir(dir, { recursive: true });
		const context: RecoveryContext = {
			attempt: 0,
			spotDeadline: new Date(now().getTime() + policy.deadlineSeconds * 1000),
			checkpointPath: join(dir, "checkpoint.json"),
			authenticationKey: randomBytes(32).toString("hex"),
			producerTaskIds: new Set(),
		};
		let current = profile;
		try {
			for (;;) {
				request.signal.throwIfAborted();
				try {
					return await scoreOnce({ ...request, profile: current }, context);
				} catch (error) {
					if (!(error instanceof RecoverableSpotFailure) || !current.spot)
						throw error;
					// No replacement can overlap an unknown or not-yet-deleted resource.
					const cleanupDeadline = Date.now() + 120000;
					for (;;) {
						request.signal.throwIfAborted();
						const previous = await prisma.vmafComputeTask.findUnique({
							where: { id: error.taskId },
						});
						if (!previous)
							throw new Error("VMAF recovery ownership record is missing");
						if (previous.cleanedAt) break;
						if (Date.now() >= cleanupDeadline)
							throw new Error(
								"VMAF recovery is waiting for confirmed resource cleanup",
							);
						if (await cleanup(previous, true)) break;
						await delay(pollMs, undefined, { signal: request.signal });
					}
					// Batch needs at least 60 seconds to launch. Wait out a smaller
					// remaining window instead of trying a doomed Spot submission.
					if (
						context.attempt < policy.maxRetries &&
						context.spotDeadline.getTime() - now().getTime() < 60000 &&
						now() < context.spotDeadline
					)
						await wait(
							context.spotDeadline.getTime() - now().getTime(),
							request.signal,
						);
					const fallback =
						context.attempt >= policy.maxRetries ||
						now() >= context.spotDeadline;
					context.transitionReason = fallback
						? now() >= context.spotDeadline
							? "SPOT_DEADLINE"
							: "RETRY_LIMIT"
						: error.reason;
					context.attempt++;
					if (fallback) current = { ...profile, spot: false };
					// Avoid retry storms while retaining the fixed Spot deadline.
					await delay(pollMs, undefined, { signal: request.signal });
				}
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	let reconciling = false;
	async function reconcile(): Promise<void> {
		if (reconciling) return;
		reconciling = true;
		try {
			let cursor: string | undefined;
			for (;;) {
				const tasks = await prisma.vmafComputeTask.findMany({
					where: { cleanedAt: null },
					orderBy: { id: "asc" },
					take: 100,
					...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
				});
				for (const snapshot of tasks) {
					if (active.has(snapshot.id)) continue;
					// Earlier provider teardown may outlive the heartbeat window.
					// The page is only an inventory; peer liveness comes from this read.
					const task = await prisma.vmafComputeTask.findUnique({
						where: { id: snapshot.id },
					});
					if (!task || task.cleanedAt) continue;
					const parent = await prisma.vmafJob.findUnique({
						where: { id: task.vmafJobId },
						select: { status: true },
					});
					const stale = now().getTime() - task.heartbeatAt.getTime() > 120_000;
					if (
						parent?.status === "RUNNING" &&
						!stale &&
						task.expiresAt > now() &&
						task.state !== "CLEANUP_PENDING"
					)
						continue;
					if (
						parent?.status === "RUNNING" &&
						!task.receipt &&
						!(
							task.error &&
							["PREEMPTED", "CAPACITY", "SPOT_DEADLINE"].includes(task.error) &&
							!stale
						) &&
						(stale || task.expiresAt <= now())
					) {
						// Serialize the stale decision with peer heartbeat/result writes.
						// A no-op task CAS holds its row until the parent is fenced;
						// PREPARING keeps its existing cleanup/submit state machine.
						const retired = await prisma.$transaction(async (tx) => {
							const claimed = await tx.vmafComputeTask.updateMany({
								where: {
									id: task.id,
									organizationId: task.organizationId,
									vmafJobId: task.vmafJobId,
									state: task.state,
									cleanedAt: null,
									heartbeatAt: task.heartbeatAt,
									expiresAt: task.expiresAt,
									error: task.error,
									receipt: { equals: DB_NULL },
								},
								data: { heartbeatAt: task.heartbeatAt },
							});
							if (claimed.count !== 1) return false;
							const parentClaim = await tx.vmafJob.updateMany({
								where: { id: task.vmafJobId, status: "RUNNING" },
								data: {
									status: "ERROR",
									error:
										"Cloud measurement worker was lost or exceeded its deadline; cleanup continues",
								},
							});
							return parentClaim.count === 1;
						});
						if (!retired) continue;
					}
					try {
						await cleanup(task);
					} catch {
						/* Keep ownership; do not log credentials/URLs. */
					}
				}
				if (tasks.length < 100) break;
				cursor = tasks[tasks.length - 1]?.id;
			}
		} finally {
			reconciling = false;
		}
	}
	return { score, reconcile, resolveProfile };
}
