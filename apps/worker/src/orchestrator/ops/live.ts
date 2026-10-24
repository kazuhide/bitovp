/**
 * : live members extracted VERBATIM from sdk-ops.ts. The
 * Pick<SdkOps, …> return type restores the contextual typing the members had
 * inside the monolithic literal; facade-freeze.test.ts pins the union.
 */
import {
	AdInsertionSettings,
	AdMarkersSource,
	AutoRestartConfiguration,
	AvailabilityStartTimeMode,
	CacheControlSettings,
	CacheControlSettingsDash,
	CacheControlSettingsHls,
	CacheControlSettingsSegments,
	ClockSynchronizationMode,
	DashManifestAdMarkerSettings,
	DashScte35EventStreamSignalling,
	DashScte35PeriodOption,
	EncodingMode,
	EsamSettings,
	HlsInput,
	HlsManifestAdMarkerSettings,
	HlsManifestAdMarkerType,
	InsertableContent,
	InsertableContentInput,
	LiveAutoShutdownConfiguration,
	LiveAutoShutdownConfigurationUpdateRequest,
	LiveDashManifest,
	LiveHlsManifest,
	ManifestGenerator,
	PoisEndpointCredentials,
	ProgramDateTimePlacement,
	ProgramDateTimePlacementMode,
	ProgramDateTimeSettings,
	ProgramDateTimeSource,
	ResetLiveManifestTimeShift,
	ReuploadSettings,
	RtmpIngestPoint,
	ScheduledInsertableContent,
	Scte35Cue,
	StartLiveChannelEncodingRequest,
	StartLiveEncodingRequest,
	UpdateEncodingRtmpIngestPointRequest,
} from "@bitmovin/api-sdk";
import {
	liveAutoShutdownFingerprint,
	liveAutoShutdownUpdateParamsSchema,
} from "@bitovp/core";
import type { LiveHeartbeatSample, SdkOps } from "../sdk-ops";
import { startWithRetry1004 } from "../start-1004-retry";
import type { OpsContext } from "./context";
import {
	cacheControl,
	optEnum,
	sdkEnumValue,
	TERMINAL_ENCODING_STATUSES,
} from "./shared";

export function createLiveOps(
	ctx: OpsContext,
): Pick<
	SdkOps,
	| "listRunningLiveEncodings"
	| "createHlsLiveInput"
	| "startLiveEncoding"
	| "stopLiveEncoding"
	| "restartLiveEncoding"
	| "updateLiveAutoShutdown"
	| "getLiveEncodingDetails"
	| "getLiveStartRequest"
	| "getLiveHeartbeat"
	| "resetLiveManifestTimeshift"
	| "insertScte35Cue"
	| "updateLiveRtmpIngestPoints"
	| "scheduleInsertableContent"
	| "createLiveInsertableContent"
	| "getLiveInsertableContent"
	| "listLiveInsertableContent"
	| "listScheduledInsertableContent"
> {
	const { api, audited, id, options, runLiveStart } = ctx;
	// review-223 F3: the SDK default page is 25 — a channel that accumulated
	// more contents (slates re-registered across restarts adopt by name, but
	// every distinct schedule row mints one) would make adopt-by-name miss and
	// the READY poll throw "not found". C6: limit ≤ 100, paginate to
	// exhaustion, same as every other list in this file.
	async function listAllInsertableContent(
		encodingId: string,
	): Promise<Array<{ id?: string }>> {
		const limit = 100;
		const out: Array<{ id?: string }> = [];
		for (let offset = 0; ; offset += limit) {
			const page = await audited(
				"GET",
				`/encoding/encodings/${encodingId}/live/insertable-content?limit=${limit}&offset=${offset}`,
				undefined,
				() =>
					api.encoding.encodings.live.insertableContent.list(encodingId, (q) =>
						q.limit(limit).offset(offset),
					),
				(r) => ({ count: r.items?.length ?? 0 }),
			);
			const items = page.items ?? [];
			out.push(...items);
			if (items.length < limit) {
				return out;
			}
		}
	}
	return {
		listRunningLiveEncodings: async () => {
			// C6: limit ≤ 100, paginate to exhaustion. Filtered server-side by type and
			// status so a busy account does not have to be drained in full.
			const limit = 100;
			const out: Array<{
				id: string;
				name?: string;
				status: string;
				createdAt?: string;
			}> = [];
			// NON-TERMINAL, filtered CLIENT-SIDE. The first version queried
			// `status=RUNNING` and `status=STARTING` server-side — and `STARTING` is not
			// a Bitmovin status at all (the enum is CREATED/QUEUED/RUNNING/FINISHED/
			// ERROR/CANCELED/TRANSFER_ERROR), while QUEUED and CREATED, which ARE, were
			// never queried. A duplicate-CREATE encoding waits in QUEUED for capacity,
			// so the one state the #48 mechanism actually produces was invisible
			// (review catch). Listing by type and filtering here cannot go stale when
			// Bitmovin adds a state; a server-side allow-list can.
			for (let offset = 0; ; offset += limit) {
				const page = await api.encoding.encodings.list((q) =>
					q.type("LIVE").limit(limit).offset(offset),
				);
				const items = page.items ?? [];
				for (const enc of items) {
					if (!enc.id) {
						continue;
					}
					const encStatus = String(enc.status ?? "UNKNOWN");
					if (TERMINAL_ENCODING_STATUSES.has(encStatus)) {
						continue;
					}
					// An Invalid Date is TRUTHY, so a bare `enc.createdAt ? …` did not
					// guard it and `.toISOString` threw `RangeError`, killing the whole
					// listing over one bad timestamp (review catch).
					const created =
						enc.createdAt === undefined ? undefined : new Date(enc.createdAt);
					out.push({
						id: enc.id,
						...(enc.name ? { name: enc.name } : {}),
						status: encStatus,
						...(created && !Number.isNaN(created.getTime())
							? { createdAt: created.toISOString() }
							: {}),
					});
				}
				if (items.length < limit) {
					break;
				}
			}
			return out;
		},

		createHlsLiveInput: (p) =>
			audited(
				"POST",
				"/encoding/inputs/hls",
				p,
				() =>
					api.encoding.inputs.hls.create(
						new HlsInput({
							name: p.name,
							url: p.url,
							adMarkersSource: optEnum(
								AdMarkersSource,
								p.adMarkersSource,
								"AdMarkersSource",
							),
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		startLiveEncoding: (encodingId, p) => {
			const { encodingOption, ...requestParams } = p;
			// Public plans and persisted START_LIVE_ENCODING options use ms.
			// Bitmovin LiveDashManifest uses seconds. Convert once at this
			// boundary, sharing the values with the audit and every SDK retry.
			const dashManifests = p.dashManifests?.map((m) => ({
				...m,
				suggestedPresentationDelay:
					m.suggestedPresentationDelay === undefined
						? undefined
						: m.suggestedPresentationDelay / 1000,
				minimumUpdatePeriod:
					m.minimumUpdatePeriod === undefined
						? undefined
						: m.minimumUpdatePeriod / 1000,
			}));
			if (dashManifests !== undefined) {
				requestParams.dashManifests = dashManifests;
			}
			const live = api.encoding.encodings.live;
			const start = (request: StartLiveEncodingRequest) =>
				runLiveStart(encodingId, p.reuploadSettings, () =>
					encodingOption === "HD"
						? live.hd.start(encodingId, request)
						: live.start(encodingId, request),
				);
			const Request =
				encodingOption === "HD"
					? StartLiveChannelEncodingRequest
					: StartLiveEncodingRequest;
			return audited(
				"POST",
				`/encoding/encodings/${encodingId}/live/${encodingOption === "HD" ? "hd/" : ""}start`,
				// streamKey rides the snapshot; redactSecrets masks it at
				// persistence (the ledgered structural exception). The POIS
				// basic-auth pair does NOT: it is replaced by presence flags
				// here (the DRM/Zixi excluded-secret precedent), so no snapshot
				// or audit row can carry it even before redactSecrets runs.
				(() => {
					if (!p.esamSettings) {
						return requestParams;
					}
					// DESTRUCTURE the pair out rather than setting it undefined:
					// an `undefined` key still exists, so redactSecrets would emit
					// `"password":"[REDACTED]"` right beside
					// `poisPasswordProvided:false` — contradictory audit data
					// implying a password was sent (review catch N1).
					const { username, password, ...rest } = p.esamSettings;
					return {
						...requestParams,
						esamSettings: {
							...rest,
							poisUsernameProvided: username !== undefined,
							poisPasswordProvided: password !== undefined,
						},
					};
				})(),
				// : live start validates the SAME stamped creates as
				// VOD start and hits the same settle window (measured: a
				// scheduled channel's live/start answered 500/1004).
				() =>
					startWithRetry1004(
						() =>
							start(
								new Request({
									streamKey: p.streamKey,
									hlsManifests: p.hlsManifests?.map(
										(m) =>
											new LiveHlsManifest({
												manifestId: m.manifestId,
												timeshift: m.timeshift,
												liveEdgeOffset: m.liveEdgeOffset,
												insertProgramDateTime: m.insertProgramDateTime,
												// Plan-side source/placement.mode map onto the SDK's
												// longer programDateTimeSource / programDateTimePlacement
												// .programDateTimePlacementMode field names.
												programDateTimeSettings: m.programDateTimeSettings
													? new ProgramDateTimeSettings({
															programDateTimeSource: optEnum(
																ProgramDateTimeSource,
																m.programDateTimeSettings.source,
																"ProgramDateTimeSource",
															),
															programDateTimePlacement: m
																.programDateTimeSettings.placement
																? new ProgramDateTimePlacement({
																		programDateTimePlacementMode: optEnum(
																			ProgramDateTimePlacementMode,
																			m.programDateTimeSettings.placement.mode,
																			"ProgramDateTimePlacementMode",
																		),
																		interval:
																			m.programDateTimeSettings.placement
																				.interval,
																	})
																: undefined,
														})
													: undefined,
												// C14: HLS ad markers — present only when the plan opted in.
												adMarkerSettings: m.adMarkerSettings
													? new HlsManifestAdMarkerSettings({
															enabledMarkerTypes:
																m.adMarkerSettings.enabledMarkerTypes?.map(
																	(t) =>
																		sdkEnumValue(
																			HlsManifestAdMarkerType,
																			t,
																			"HlsManifestAdMarkerType",
																		),
																),
															disablePreannouncing:
																m.adMarkerSettings.disablePreannouncing,
														})
													: undefined,
											}),
									),
									dashManifests: dashManifests?.map(
										(m) =>
											new LiveDashManifest({
												manifestId: m.manifestId,
												timeshift: m.timeshift,
												liveEdgeOffset: m.liveEdgeOffset,
												suggestedPresentationDelay:
													m.suggestedPresentationDelay,
												minimumUpdatePeriod: m.minimumUpdatePeriod,
												availabilityStartTimeMode: optEnum(
													AvailabilityStartTimeMode,
													m.availabilityStartTimeMode,
													"AvailabilityStartTimeMode",
												),
												// C14: DASH ad markers — present only when the plan opted in.
												adMarkerSettings: m.adMarkerSettings
													? new DashManifestAdMarkerSettings({
															periodOption: optEnum(
																DashScte35PeriodOption,
																m.adMarkerSettings.periodOption,
																"DashScte35PeriodOption",
															),
															eventStreamSignalling: optEnum(
																DashScte35EventStreamSignalling,
																m.adMarkerSettings.eventStreamSignalling,
																"DashScte35EventStreamSignalling",
															),
														})
													: undefined,
											}),
									),
									liveEncodingMode: optEnum(
										EncodingMode,
										p.liveEncodingMode,
										"EncodingMode",
									),
									reuploadSettings: p.reuploadSettings
										? new ReuploadSettings({
												// The request-scoped fetch restores null after SDK serialization.
												dashManifestInterval: p.reuploadSettings
													.dashManifestInterval as number | undefined,
												muxingInitFileInterval: p.reuploadSettings
													.muxingInitFileInterval as number | undefined,
											})
										: undefined,
									manifestGenerator: optEnum(
										ManifestGenerator,
										p.manifestGenerator,
										"ManifestGenerator",
									),
									autoRestartConfiguration: p.autoRestartConfiguration
										? new AutoRestartConfiguration(p.autoRestartConfiguration)
										: undefined,
									autoShutdownConfiguration: p.autoShutdownConfiguration
										? new LiveAutoShutdownConfiguration(
												p.autoShutdownConfiguration,
											)
										: undefined,
									esamSettings: p.esamSettings
										? new EsamSettings({
												poisEndpoint: p.esamSettings.poisEndpoint,
												acquisitionPointIdentity:
													p.esamSettings.acquisitionPointIdentity,
												zoneIdentity: p.esamSettings.zoneIdentity,
												adAvailOffset: p.esamSettings.adAvailOffset,
												// Only build the credentials block when the vault
												// actually resolved a pair — an empty object would
												// send blank basic-auth.
												poisEndpointCredentials:
													p.esamSettings.username !== undefined ||
													p.esamSettings.password !== undefined
														? new PoisEndpointCredentials({
																username: p.esamSettings.username,
																password: p.esamSettings.password,
															})
														: undefined,
											})
										: undefined,
									cacheControlSettings: p.cacheControlSettings
										? new CacheControlSettings({
												hls: p.cacheControlSettings.hls
													? new CacheControlSettingsHls({
															multiVariantPlaylist: cacheControl(
																p.cacheControlSettings.hls.multiVariantPlaylist,
															),
															variantPlaylist: cacheControl(
																p.cacheControlSettings.hls.variantPlaylist,
															),
														})
													: undefined,
												dash: p.cacheControlSettings.dash
													? new CacheControlSettingsDash({
															timelineManifest: cacheControl(
																p.cacheControlSettings.dash.timelineManifest,
															),
															templateManifest: cacheControl(
																p.cacheControlSettings.dash.templateManifest,
															),
														})
													: undefined,
												segments: p.cacheControlSettings.segments
													? new CacheControlSettingsSegments({
															initSegment: cacheControl(
																p.cacheControlSettings.segments.initSegment,
															),
															mediaSegment: cacheControl(
																p.cacheControlSettings.segments.mediaSegment,
															),
														})
													: undefined,
											})
										: undefined,
									adInsertionSettings: p.adInsertionSettings
										? new AdInsertionSettings({
												enableEsamMediaPointInsertion:
													p.adInsertionSettings.enableEsamMediaPointInsertion,
												clockSynchronizationMode: optEnum(
													ClockSynchronizationMode,
													p.adInsertionSettings.clockSynchronizationMode,
													"ClockSynchronizationMode",
												),
											})
										: undefined,
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
					...(done.retries > 0 ? { start1004Retries: done.retries } : {}),
					...(done.reconciledFrom
						? { startReconciledFrom: done.reconciledFrom }
						: {}),
				}),
			).then(() => undefined);
		},

		stopLiveEncoding: (encodingId) =>
			audited(
				"POST",
				`/encoding/encodings/${encodingId}/live/stop`,
				{},
				() => api.encoding.encodings.live.stop(encodingId),
				(r) => ({ id: r.id }),
			).then(() => undefined),

		restartLiveEncoding: (encodingId) =>
			audited(
				"POST",
				`/encoding/encodings/${encodingId}/live/restart`,
				{},
				() => api.encoding.encodings.live.restart(encodingId),
				(r) => ({ id: r.id }),
			).then(() => undefined),

		updateLiveAutoShutdown: async (encodingId, configuration) => {
			const response = await audited(
				"POST",
				`/encoding/encodings/${encodingId}/live/update-autoshutdown-config`,
				configuration,
				() =>
					api.encoding.encodings.live.updateAutoshutdownConfig.create(
						encodingId,
						new LiveAutoShutdownConfigurationUpdateRequest(configuration),
					),
				(r) => ({
					configuration: {
						bytesReadTimeoutSeconds: r.bytesReadTimeoutSeconds,
						streamTimeoutMinutes: r.streamTimeoutMinutes,
						waitingForFirstConnectTimeoutMinutes:
							r.waitingForFirstConnectTimeoutMinutes,
					},
					scheduledShutdownAt: r.scheduledShutdownAt,
				}),
			);
			const accepted = liveAutoShutdownUpdateParamsSchema.parse({
				configuration: {
					...(response.bytesReadTimeoutSeconds != null
						? { bytesReadTimeoutSeconds: response.bytesReadTimeoutSeconds }
						: {}),
					...(response.streamTimeoutMinutes != null
						? { streamTimeoutMinutes: response.streamTimeoutMinutes }
						: {}),
					...(response.waitingForFirstConnectTimeoutMinutes != null
						? {
								waitingForFirstConnectTimeoutMinutes:
									response.waitingForFirstConnectTimeoutMinutes,
							}
						: {}),
				},
			}).configuration;
			if (
				liveAutoShutdownFingerprint(encodingId, accepted) !==
				liveAutoShutdownFingerprint(encodingId, configuration)
			)
				throw new Error(
					"The accepted configuration does not match the requested automatic stop settings",
				);
			if (
				accepted.streamTimeoutMinutes !== undefined &&
				response.scheduledShutdownAt == null
			)
				throw new Error(
					"The accepted configuration has no confirmed scheduled shutdown instant",
				);
			return {
				configuration: accepted,
				...(response.scheduledShutdownAt !== undefined
					? {
							scheduledShutdownAt:
								response.scheduledShutdownAt === null
									? null
									: new Date(response.scheduledShutdownAt).toISOString(),
						}
					: {}),
			};
		},

		getLiveEncodingDetails: async (encodingId) => {
			const live = await api.encoding.encodings.live.get(encodingId);
			return {
				streamKey: live.streamKey,
				encoderIp: live.encoderIp,
				application: live.application,
			};
		},

		getLiveStartRequest: async (encodingId) => {
			// C7 snapshot source — plain JSON (model instances/Dates don't
			// belong in Json columns). Persisting callers MUST redactSecrets.
			const startRequest =
				await api.encoding.encodings.live.getStartRequest(encodingId);
			return JSON.parse(JSON.stringify(startRequest)) as unknown;
		},

		getLiveHeartbeat: async (encodingId) => {
			const heartbeat =
				await api.encoding.encodings.live.heartbeat.get(encodingId);
			return JSON.parse(JSON.stringify(heartbeat)) as LiveHeartbeatSample;
		},

		resetLiveManifestTimeshift: (encodingId, p) =>
			audited(
				"POST",
				`/encoding/encodings/${encodingId}/live/reset-live-manifest-timeshift`,
				p,
				() =>
					api.encoding.encodings.live.resetLiveManifestTimeshift.create(
						encodingId,
						new ResetLiveManifestTimeShift({
							residualPeriodInSeconds: p.residualPeriodInSeconds,
							offsetInSeconds: p.offsetInSeconds,
							manifestIds: p.manifestIds,
							shiftProgressiveMuxingStartPosition:
								p.shiftProgressiveMuxingStartPosition,
						}),
					),
				(r) => ({ id: r.id }),
			).then(() => undefined),

		updateLiveRtmpIngestPoints: (encodingId, ingestPoints) =>
			audited(
				"PATCH",
				`/encoding/live/encodings/${encodingId}/actions/update-rtmp-ingest-points`,
				{
					ingestPoints: ingestPoints.map(({ applicationName }) => ({
						applicationName,
					})),
				},
				async () => {
					try {
						return await api.encoding.live.encodings.actions.patch(
							encodingId,
							new UpdateEncodingRtmpIngestPointRequest({
								ingestPoints: ingestPoints.map(
									(point) => new RtmpIngestPoint(point),
								),
							}),
						);
					} catch (err) {
						const safe = new Error(
							"RTMP ingest update provider result is unknown",
						);
						const status = (err as { httpStatusCode?: unknown } | null)
							?.httpStatusCode;
						if (typeof status === "number")
							Object.assign(safe, {
								httpStatusCode: status,
								shortMessage: "RTMP ingest update provider result is unknown",
							});
						throw safe;
					}
				},
				() => ({ acknowledged: true }),
			).then(() => undefined),

		insertScte35Cue: (encodingId, p) =>
			audited(
				"POST",
				`/encoding/encodings/${encodingId}/live/scte-35-cue`,
				p,
				() =>
					api.encoding.encodings.live.scte35Cue.create(
						encodingId,
						new Scte35Cue({
							cueDuration: p.cueDuration,
							manifestIds: p.manifestIds,
						}),
					),
				(r) => ({ id: (r as { id?: string }).id }),
			).then((result) => ({
				id:
					typeof (result as { id?: unknown }).id === "string"
						? (result as { id: string }).id
						: null,
			})),

		createLiveInsertableContent: (encodingId, p) =>
			audited(
				"POST",
				`/encoding/encodings/${encodingId}/live/insertable-content`,
				// Inputs are referenced by id — no secrets in the snapshot.
				{ name: p.name, description: p.description, inputs: p.inputs },
				() =>
					api.encoding.encodings.live.insertableContent.create(
						encodingId,
						new InsertableContent({
							name: p.name,
							...(p.description ? { description: p.description } : {}),
							inputs: p.inputs.map(
								(input) => new InsertableContentInput(input),
							),
						}),
					),
				(r) => ({ id: r.id }),
			).then((r) => id(r)),

		// The SDK surface has create+list only (verified 1.269 — no point-GET),
		// so status reads go through the list and select by id.
		getLiveInsertableContent: async (encodingId, contentId) => {
			const items = await listAllInsertableContent(encodingId);
			const hit = items.find(
				(item) => (item as { id?: string }).id === contentId,
			);
			if (!hit) {
				throw new Error(
					`insertable content ${contentId} not found on encoding ${encodingId}`,
				);
			}
			return {
				id: contentId,
				status: String((hit as { status?: string }).status ?? "UNKNOWN"),
			};
		},

		listLiveInsertableContent: async (encodingId) =>
			(await listAllInsertableContent(encodingId)).map((item) => ({
				id: id(item),
				name: (item as { name?: string }).name ?? null,
				status: String((item as { status?: string }).status ?? "UNKNOWN"),
				description:
					typeof (item as { description?: unknown }).description === "string"
						? (item as { description: string }).description
						: null,
			})),

		// C6 like every other list here: limit ≤ 100, paginate to exhaustion.
		// A channel accumulates one scheduled row per fired slate over its life,
		// so the second page is reachable on a long-running channel.
		listScheduledInsertableContent: async (encodingId) => {
			const limit = 100;
			const out: {
				id: string | null;
				contentId: string | null;
				status: string;
				createdAt: string | null;
			}[] = [];
			for (let offset = 0; ; offset += limit) {
				const page = await audited(
					"GET",
					// `scheduled`, not `schedule` — the C7 snapshot must name the
					// endpoint that was actually called, and these are SIBLINGS in the
					// SDK (one POSTs an insertion, one lists them). The comment two lines
					// below already draws that distinction; the audit path did not
					// (review-300).
					`/encoding/encodings/${encodingId}/live/insertable-content/scheduled?limit=${limit}&offset=${offset}`,
					undefined,
					// `schedule` (POST one) and `scheduled` (LIST them) are SIBLINGS
					// in the SDK; the create half above uses the former.
					() =>
						api.encoding.encodings.live.insertableContent.scheduled.list(
							encodingId,
							(q) => q.limit(limit).offset(offset),
						),
					(r) => ({ count: r.items?.length ?? 0 }),
				);
				const items = page.items ?? [];
				for (const item of items) {
					// An Invalid Date is TRUTHY (the RangeError this file already
					// learned about in listRunningLiveEncodings), so it is checked,
					// not assumed.
					const created =
						(item as { createdAt?: Date }).createdAt === undefined
							? undefined
							: new Date((item as { createdAt: Date }).createdAt);
					out.push({
						id: (item as { id?: string }).id ?? null,
						contentId: (item as { contentId?: string }).contentId ?? null,
						status: String((item as { status?: string }).status ?? "UNKNOWN"),
						createdAt:
							created && !Number.isNaN(created.getTime())
								? created.toISOString()
								: null,
					});
				}
				if (items.length < limit) {
					return out;
				}
			}
		},

		scheduleInsertableContent: (encodingId, p) =>
			audited(
				"POST",
				`/encoding/encodings/${encodingId}/live/insertable-content/${p.contentId}/schedule`,
				{ durationSeconds: p.durationSeconds },
				() =>
					api.encoding.encodings.live.insertableContent.schedule.create(
						encodingId,
						p.contentId,
						new ScheduledInsertableContent({
							durationInSeconds: p.durationSeconds,
						}),
					),
				(r) => ({ id: r.id }),
				// The created entry's id, RETURNED rather than discarded. It was
				// already extracted for the audit snapshot and then thrown away by
				// `.then( => undefined)`. Recording it is what lets the slate guard
				// ask whether a live entry is MINE, instead of subtracting a count of
				// our airings from a count of the provider's live entries — two
				// populations that decay at different rates (review-300).
			).then((r) => (r as { id?: string }).id ?? null),
	};
}
