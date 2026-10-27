/**
 * : encoding members extracted VERBATIM from sdk-ops.ts. The
 * Pick<SdkOps, …> return type restores the contextual typing the members had
 * inside the monolithic literal; facade-freeze.test.ts pins the union.
 */

import {
	AiSceneAnalysis,
	AiSceneAnalysisAssetDescription,
	AiSceneAnalysisAutomaticAdPlacement,
	AiSceneAnalysisFeatures,
	AiSceneAnalysisOutputLanguageCodes,
	AiSceneAnalysisRegulatoryAdvisories,
	AllSceneBoundaries,
	AudioVideoSyncMode,
	AutomaticAdPlacementPosition,
	CloudRegion,
	Encoding,
	EncodingMode,
	InfrastructureSettings,
	KantarWatermark,
	ManifestGenerator,
	ManifestResource,
	NexGuardFileMarker,
	NexGuardWatermarkingStrength,
	NexGuardWatermarkingType,
	RegulatoryAdvisoryTopic,
	Scheduling,
	StartEncodingRequest,
	Tweaks,
} from "@bitmovin/api-sdk";
import { verificationKeyLabel } from "@bitovp/core";
import { assertInternalHevcV2Access } from "../internal-hevc-v2";
import type { SdkOps } from "../sdk-ops";
import {
	VerificationIdentityError,
	VerificationProviderIdDefinitelyNotPersistedError,
	VerificationProviderOwnershipLostError,
	verificationCreateIdentity,
} from "../stamping-fetch";
import { startWithRetry1004 } from "../start-1004-retry";
import type { OpsContext } from "./context";
import {
	adoptOrCreateStamped,
	findStampedResource,
	findVerificationEncodingResources,
	optEnum,
	outputs,
	sdkEnumValue,
	taskResult,
	VerificationProviderLookupError,
} from "./shared";

/** Audit only the bounded comparison result; provider-owned opaque data is untrusted. */
function verificationCustomDataAudit(
	customData: unknown,
	expected: {
		jobId: string;
		verificationKey: string;
		requestSha256: string;
		resources: ReadonlyArray<{ step: string; name: string }>;
	},
): unknown {
	const marker = (
		customData as
			| {
					bitovp?: {
						job?: unknown;
						step?: unknown;
						verification?: { key?: unknown; requestSha256?: unknown };
					};
			  }
			| undefined
	)?.["bitovp"];
	return {
		markerPresent: marker !== undefined,
		jobMatches: marker?.job === expected.jobId,
		stepMatches:
			typeof marker?.step === "string" &&
			expected.resources.some((resource) => resource.step === marker.step),
		verification: {
			keyMatches: marker?.verification?.key === expected.verificationKey,
			requestSha256Matches:
				marker?.verification?.requestSha256 === expected.requestSha256,
		},
	};
}

export function createEncodingLifecycleOps(
	ctx: OpsContext,
): Pick<
	SdkOps,
	| "createEncoding"
	| "findVerificationEncodings"
	| "createKantarWatermark"
	| "createNexGuardFileMarker"
	| "startEncoding"
	| "stopEncoding"
	| "getEncodingStatus"
	| "getEncodingMessages"
> {
	const { api, audited, stampAuditAdopt, id, options } = ctx;
	return {
		findVerificationEncodings: (p) =>
			findVerificationEncodingResources({
				label: "encoding",
				jobId: p.jobId,
				verificationKey: p.verificationKey,
				requestSha256: p.requestSha256,
				resources: p.resources,
				list: (q) =>
					audited(
						"GET",
						"/encoding/encodings",
						q,
						() => api.encoding.encodings.list(q),
						(result) => ({
							items: result.items?.map((item) => ({
								id: item.id,
								nameMatches: p.resources.some(
									(resource) => resource.name === item.name,
								),
								labelMatches:
									item.labels?.includes(
										verificationKeyLabel(p.verificationKey),
									) === true,
							})),
						}),
					),
				customData: (rid) =>
					audited(
						"GET",
						`/encoding/encodings/${rid}/customData`,
						{},
						() => api.encoding.encodings.customdata.get(rid),
						(result) => verificationCustomDataAudit(result.customData, p),
					),
			}),
		createEncoding: async (p) => {
			if (options.internalHevcV2)
				assertInternalHevcV2Access(
					options.bitmovinAccountId,
					options.internalHevcV2,
				);
			const rawVerification = (
				options.stamp as { verification?: unknown } | undefined
			)?.verification;
			let verification: ReturnType<typeof verificationCreateIdentity>;
			if (rawVerification !== undefined) {
				const candidate =
					typeof rawVerification === "object" && rawVerification !== null
						? (rawVerification as {
								key?: unknown;
								requestSha256?: unknown;
							})
						: undefined;
				verification = verificationCreateIdentity(
					candidate?.key,
					candidate?.requestSha256,
				);
				if (!verification) {
					// A present-but-empty runtime object is not the same thing as no
					// verification protocol. Reject it at the last pre-provider boundary.
					throw new VerificationIdentityError("VERIFICATION_IDENTITY_INVALID");
				}
			}
			const ownershipCallback = options.stamp?.onEncodingCreated;
			if (Boolean(verification) !== Boolean(ownershipCallback)) {
				// Verification identity and its durability barrier form one protocol.
				// Either half on its own is unsafe: without the callback a paid id can
				// be orphaned, while a callback on an ordinary create could accidentally
				// authorize verification-only compensation.
				throw new VerificationProviderLookupError(
					"VERIFICATION_PROVIDER_IDENTITY_CONFLICT",
					"encoding verification ownership protocol",
				);
			}
			if (
				verification &&
				p.labels?.includes(verificationKeyLabel(verification.key)) !== true
			) {
				// customData alone is not recoverable through the bounded provider
				// query. Require the canonical label at the final provider boundary,
				// before either lookup or POST, so a future compiler/wiring regression
				// cannot create a paid resource recovery can never enumerate.
				throw new VerificationProviderLookupError(
					"VERIFICATION_PROVIDER_IDENTITY_CONFLICT",
					"encoding",
				);
			}
			let verificationStep: string | undefined;
			if (verification) {
				const jobId = options.stamp?.jobId;
				verificationStep = options.stamp?.currentStep();
				if (
					typeof jobId !== "string" ||
					jobId.length === 0 ||
					jobId.length > 512 ||
					typeof verificationStep !== "string" ||
					verificationStep.length === 0 ||
					verificationStep.length > 512
				) {
					throw new VerificationProviderLookupError(
						"VERIFICATION_PROVIDER_IDENTITY_CONFLICT",
						"encoding verification job/step marker",
					);
				}
			}
			const callStamp =
				verification && options.stamp
					? {
							...options.stamp,
							verification,
							// Freeze the step used by adoption and by the explicit provider
							// marker below. A mutable executor cursor must not produce two
							// identities within one paid create call.
							currentStep: () => verificationStep,
						}
					: options.stamp;
			return adoptOrCreateStamped({
				label: "encoding",
				stamp: callStamp,
				lookup: (expect) =>
					findStampedResource({
						label: "encoding",
						expect,
						...(expect.verification
							? {
									verificationResource: {
										name: p.name,
										label: verificationKeyLabel(expect.verification.key),
									},
								}
							: {}),
						list: (q) =>
							api.encoding.encodings.list({
								...q,
								sort: "createdAt:DESC",
								name: p.name,
							}),
						customData: (rid) => api.encoding.encodings.customdata.get(rid),
					}),
				auditAdopt: stampAuditAdopt("/encoding/encodings"),
				onResolved: async (providerId, source) => {
					const callback = options.stamp?.onEncodingCreated;
					if (!callback && !verification) {
						return;
					}
					if (!callback) {
						throw new VerificationProviderOwnershipLostError(providerId);
					}
					let outcome: "PERSISTED" | "OWNERSHIP_LOST";
					try {
						outcome = await callback(providerId, source);
					} catch (err) {
						const durability =
							source === "created" &&
							err instanceof VerificationProviderIdDefinitelyNotPersistedError
								? ("DEFINITELY_NOT_PERSISTED" as const)
								: ("PERSISTENCE_UNKNOWN" as const);
						const compensation =
							durability === "DEFINITELY_NOT_PERSISTED"
								? await compensateCreatedEncoding(api, providerId)
								: {
										stop:
											source === "adopted"
												? ("SKIPPED_ADOPTED" as const)
												: ("SKIPPED_UNKNOWN" as const),
										delete:
											source === "adopted"
												? ("SKIPPED_ADOPTED" as const)
												: ("SKIPPED_UNKNOWN" as const),
									};
						throw new VerificationProviderIdPersistenceError(
							providerId,
							source,
							durability,
							compensation,
							err,
						);
					}
					if (outcome === "OWNERSHIP_LOST") {
						throw new VerificationProviderOwnershipLostError(providerId);
					}
					if (outcome !== "PERSISTED") {
						throw new VerificationProviderOwnershipLostError(providerId);
					}
				},
				create: (beforeAudit) =>
					audited(
						"POST",
						"/encoding/encodings",
						p,
						async () => {
							const result = await api.encoding.encodings.create(
								new Encoding({
									name: p.name,
									...(verification
										? {
												customData: {
													bitovp: {
														job: callStamp?.jobId,
														step: verificationStep,
														verification,
													},
												},
											}
										: {}),
									cloudRegion: sdkEnumValue(
										CloudRegion,
										p.cloudRegion,
										"CloudRegion",
									),
									encoderVersion: p.encoderVersion,
									...(p.fallbackCloudRegions?.length
										? {
												fallbackCloudRegions: p.fallbackCloudRegions.map((r) =>
													sdkEnumValue(CloudRegion, r, "CloudRegion"),
												),
											}
										: {}),
									...(p.labels?.length ? { labels: p.labels } : {}),
									...(p.infrastructure
										? {
												infrastructure: new InfrastructureSettings({
													infrastructureId: p.infrastructure.infrastructureId,
													cloudRegion: sdkEnumValue(
														CloudRegion,
														p.infrastructure.cloudRegion,
														"CloudRegion",
													),
												}),
											}
										: {}),
									...(p.staticIpId ? { staticIpId: p.staticIpId } : {}),
								}),
							);
							// Response-shape validation belongs to the provider call phase. A
							// response without an id cannot enter the durability barrier and is
							// still eligible for exact-marker re-lookup.
							id(result);
							return result;
						},
						(r) => ({ id: r.id }),
						beforeAudit
							? async (result) => {
									await beforeAudit(id(result));
								}
							: undefined,
					).then(id),
			});
		},

		createKantarWatermark: (encodingId, p) =>
			audited(
				"POST",
				`/encoding/encodings/${encodingId}/kantar-watermark`,
				// login/password are the vaulted Kantar service credentials —
				// presence flags only, mirroring the POIS/Zixi/DRM precedent.
				{
					licenseId: p.licenseId,
					channelName: p.channelName,
					contentReference: p.contentReference,
					serverUrl: p.serverUrl,
					reportPath: p.report.outputPath,
					kantarLoginProvided: true,
					kantarPasswordProvided: true,
				},
				() =>
					api.encoding.encodings.kantarWatermark.create(
						encodingId,
						new KantarWatermark({
							login: p.login,
							password: p.password,
							licenseId: p.licenseId,
							channelName: p.channelName,
							contentReference: p.contentReference,
							serverUrl: p.serverUrl,
							reportOutputs: outputs(p.report),
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createNexGuardFileMarker: (encodingId, streamId, p) =>
			audited(
				"POST",
				`/encoding/encodings/${encodingId}/streams/${streamId}/watermarking/nexguard-file-marker`,
				// license is the NexGuard secret — never snapshot it.
				{
					watermarkType: p.watermarkType,
					preset: p.preset,
					strength: p.strength,
					payload: p.payload,
				},
				() =>
					api.encoding.encodings.streams.watermarking.nexguardFileMarker.create(
						encodingId,
						streamId,
						new NexGuardFileMarker({
							license: p.license,
							watermarkType: sdkEnumValue(
								NexGuardWatermarkingType,
								p.watermarkType,
								"NexGuardWatermarkingType",
							),
							preset: p.preset,
							strength: optEnum(
								NexGuardWatermarkingStrength,
								p.strength,
								"NexGuardWatermarkingStrength",
							),
							payload: p.payload,
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		startEncoding: async (encodingId, p) => {
			if (
				(options.internalHevcV2 && p.encodingMode !== undefined) ||
				p.encodingMode === "SMART_PASS"
			)
				throw new Error(
					"Internal HEVCv2 encodingMode belongs on the codec, not START",
				);
			return audited(
				"POST",
				`/encoding/encodings/${encodingId}/start`,
				p,
				// : the ONLY retried non-transport failure — see
				// start-1004-retry.ts for the measured window this covers.
				// I-02: a start 5xx is then RECONCILED against remote state —
				// if the start actually landed, the job proceeds.
				() =>
					startWithRetry1004(
						() =>
							api.encoding.encodings.start(
								encodingId,
								new StartEncodingRequest({
									manifestGenerator: optEnum(
										ManifestGenerator,
										p.manifestGenerator,
										"ManifestGenerator",
									),
									// Plain object — the SDK request constructor maps it.
									...(p.perTitle
										? {
												perTitle:
													p.perTitle as StartEncodingRequest["perTitle"],
											}
										: {}),
									...(p.scheduling
										? { scheduling: new Scheduling(p.scheduling) }
										: {}),
									encodingMode: optEnum(
										EncodingMode,
										p.encodingMode,
										"EncodingMode",
									),
									...(p.audioVideoSyncMode
										? {
												tweaks: new Tweaks({
													audioVideoSyncMode: optEnum(
														AudioVideoSyncMode,
														p.audioVideoSyncMode,
														"AudioVideoSyncMode",
													),
												}),
											}
										: {}),
									...(p.handleVariableInputFps !== undefined
										? { handleVariableInputFps: p.handleVariableInputFps }
										: {}),
									...(p.vodHlsManifestIds
										? {
												vodHlsManifests: p.vodHlsManifestIds.map(
													(manifestId) => new ManifestResource({ manifestId }),
												),
											}
										: {}),
									...(p.vodDashManifestIds
										? {
												vodDashManifests: p.vodDashManifestIds.map(
													(manifestId) => new ManifestResource({ manifestId }),
												),
											}
										: {}),
									...(p.vodSmoothManifestIds
										? {
												vodSmoothManifests: p.vodSmoothManifestIds.map(
													(manifestId) => new ManifestResource({ manifestId }),
												),
											}
										: {}),
									...(p.previewHlsManifestIds
										? {
												previewHlsManifests: p.previewHlsManifestIds.map(
													(manifestId) => new ManifestResource({ manifestId }),
												),
											}
										: {}),
									...(p.previewDashManifestIds
										? {
												previewDashManifests: p.previewDashManifestIds.map(
													(manifestId) => new ManifestResource({ manifestId }),
												),
											}
										: {}),
									...(p.aiSceneAnalysis
										? {
												aiSceneAnalysis: new AiSceneAnalysis({
													features: new AiSceneAnalysisFeatures({
														assetDescription:
															new AiSceneAnalysisAssetDescription({
																filename:
																	p.aiSceneAnalysis.assetDescription.filename,
																outputs: outputs({
																	outputId:
																		p.aiSceneAnalysis.assetDescription.outputId,
																	outputPath:
																		p.aiSceneAnalysis.assetDescription
																			.outputPath,
																	acl: p.aiSceneAnalysis.assetDescription.acl,
																}),
															}),
														automaticAdPlacement: p.aiSceneAnalysis
															.automaticAdPlacement
															? new AiSceneAnalysisAutomaticAdPlacement({
																	schedule:
																		p.aiSceneAnalysis.automaticAdPlacement.schedule?.map(
																			(position) =>
																				new AutomaticAdPlacementPosition(
																					position,
																				),
																		),
																	allSceneBoundaries: p.aiSceneAnalysis
																		.automaticAdPlacement.allSceneBoundaries
																		? new AllSceneBoundaries(
																				p.aiSceneAnalysis.automaticAdPlacement
																					.allSceneBoundaries,
																			)
																		: undefined,
																})
															: undefined,
														regulatoryAdvisories: p.aiSceneAnalysis
															.regulatoryAdvisories
															? new AiSceneAnalysisRegulatoryAdvisories({
																	topics:
																		p.aiSceneAnalysis.regulatoryAdvisories.topics.map(
																			(topic) => RegulatoryAdvisoryTopic[topic],
																		),
																})
															: undefined,
														outputLanguageCodes: p.aiSceneAnalysis
															.outputLanguageCodes
															? new AiSceneAnalysisOutputLanguageCodes({
																	outputLanguageCodes:
																		p.aiSceneAnalysis.outputLanguageCodes,
																})
															: undefined,
													}),
												}),
											}
										: {}),
								}),
							),
						() =>
							api.encoding.encodings
								.status(encodingId)
								.then((task) => ({ status: String(task.status) })),
						options.startControl,
					),
				(done: { retries: number; reconciledFrom?: string }) => ({
					started: true,
					// The audit row says when a start needed the window, and when
					// a 5xx start turned out to have LANDED (I-02).
					...(done.retries > 0 ? { start1004Retries: done.retries } : {}),
					...(done.reconciledFrom
						? { startReconciledFrom: done.reconciledFrom }
						: {}),
				}),
			).then(() => undefined);
		},

		stopEncoding: (encodingId) =>
			audited(
				"POST",
				`/encoding/encodings/${encodingId}/stop`,
				{},
				() => api.encoding.encodings.stop(encodingId),
				(r) => ({ id: r.id }),
			).then(() => undefined),

		getEncodingStatus: (encodingId) =>
			api.encoding.encodings.status(encodingId).then(taskResult),

		// Same endpoint as getEncodingStatus, different projection: severity
		// and timestamp kept, so a message can be attributed to one insertion.
		// A read, so it is not audited (C7 snapshots mutations and provider
		// answers the step log depends on; this one lands in the step log
		// through the slate outcome entry instead).
		getEncodingMessages: (encodingId) =>
			api.encoding.encodings.status(encodingId).then((task) =>
				(task.messages ?? []).flatMap((m) => {
					const text = typeof m.text === "string" ? m.text : "";
					if (text.length === 0) {
						return [];
					}
					const date =
						m.date === undefined ? undefined : new Date(m.date as Date);
					return [
						{
							type: String(m.type ?? "INFO"),
							text,
							date:
								date !== undefined && !Number.isNaN(date.getTime())
									? date.toISOString()
									: null,
						},
					];
				}),
			),
	};
}

const COMPENSATION_TIMEOUT_MS = 10_000;

type CompensationOutcome =
	| "SUCCEEDED"
	| "FAILED"
	| "TIMED_OUT"
	| "SKIPPED_ADOPTED"
	| "SKIPPED_UNKNOWN";

export class VerificationProviderIdPersistenceError extends Error {
	readonly code = "VERIFICATION_PROVIDER_ID_PERSIST_FAILED" as const;
	readonly providerId: string;
	readonly source: "created" | "adopted";
	readonly durability: "DEFINITELY_NOT_PERSISTED" | "PERSISTENCE_UNKNOWN";
	readonly compensation: {
		stop: CompensationOutcome;
		delete: CompensationOutcome;
	};
	constructor(
		providerId: string,
		source: "created" | "adopted",
		durability: "DEFINITELY_NOT_PERSISTED" | "PERSISTENCE_UNKNOWN",
		compensation: {
			stop: CompensationOutcome;
			delete: CompensationOutcome;
		},
		cause: unknown,
	) {
		super(
			durability === "DEFINITELY_NOT_PERSISTED"
				? `VERIFICATION_PROVIDER_ID_PERSIST_FAILED: provider encoding ${providerId} could not be written before the database operation; ` +
						`compensation stop=${compensation.stop} delete=${compensation.delete}`
				: `VERIFICATION_PROVIDER_ID_PERSIST_FAILED: provider encoding ${providerId} has an unknown database commit outcome; ` +
						"no destructive compensation was attempted without readback",
			{ cause },
		);
		this.name = "VerificationProviderIdPersistenceError";
		this.providerId = providerId;
		this.source = source;
		this.durability = durability;
		this.compensation = compensation;
	}
}

async function compensateCreatedEncoding(
	api: OpsContext["api"],
	providerId: string,
): Promise<{ stop: CompensationOutcome; delete: CompensationOutcome }> {
	const stop = await boundedCompensation(() =>
		api.encoding.encodings.stop(providerId),
	);
	// Delete is attempted regardless of stop outcome. A newly created encoding
	// may not be startable/stoppable yet, while deletion is still the operation
	// that prevents an unnamed billable orphan.
	const del = await boundedCompensation(() =>
		api.encoding.encodings.delete(providerId),
	);
	return { stop, delete: del };
}

async function boundedCompensation(
	operation: () => Promise<unknown>,
): Promise<
	Exclude<CompensationOutcome, "SKIPPED_ADOPTED" | "SKIPPED_UNKNOWN">
> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			Promise.resolve()
				.then(operation)
				.then(
					() => "SUCCEEDED" as const,
					() => "FAILED" as const,
				),
			new Promise<"TIMED_OUT">((resolve) => {
				timer = setTimeout(() => resolve("TIMED_OUT"), COMPENSATION_TIMEOUT_MS);
				timer.unref?.();
			}),
		]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}
