/**
 * : drm members extracted VERBATIM from sdk-ops.ts. The
 * Pick<SdkOps, …> return type restores the contextual typing the members had
 * inside the monolithic literal; facade-freeze.test.ts pins the union.
 */
import {
	CencDrm,
	CencFairPlay,
	CencPlayReady,
	CencWidevine,
	EncryptionMode,
	ExternalIdMode,
	FairPlayDrm,
	IvSize,
	SpekeDrm,
	SpekeDrmProvider,
} from "@bitmovin/api-sdk";
import type { SdkOps } from "../sdk-ops";
import type { OpsContext } from "./context";
import {
	adoptOrCreateStamped,
	findStampedResource,
	isBitmovinError,
	optEnum,
	outputs,
	type StampPageQuery,
} from "./shared";

type Muxings = ReturnType<OpsContext["muxings"]>;

/** Each generated SDK resource is a distinct API with its own route. Bind
 * creation, pagination, and recovery to the same encoding and muxing. */
function spekeApi(
	m: Muxings,
	kind: string,
	encodingId: string,
	muxingId: string,
) {
	switch (kind) {
		case "FMP4": {
			const api = m.fmp4.drm.speke;
			return {
				create: (body: SpekeDrm) => api.create(encodingId, muxingId, body),
				list: (query: StampPageQuery) => api.list(encodingId, muxingId, query),
				customData: (id: string) =>
					api.customdata.get(encodingId, muxingId, id),
			};
		}
		case "MP4": {
			const api = m.mp4.drm.speke;
			return {
				create: (body: SpekeDrm) => api.create(encodingId, muxingId, body),
				list: (query: StampPageQuery) => api.list(encodingId, muxingId, query),
				customData: (id: string) =>
					api.customdata.get(encodingId, muxingId, id),
			};
		}
		case "TS": {
			const api = m.ts.drm.speke;
			return {
				create: (body: SpekeDrm) => api.create(encodingId, muxingId, body),
				list: (query: StampPageQuery) => api.list(encodingId, muxingId, query),
				customData: (id: string) =>
					api.customdata.get(encodingId, muxingId, id),
			};
		}
		case "PROGRESSIVE_TS": {
			const api = m.progressiveTs.drm.speke;
			return {
				create: (body: SpekeDrm) => api.create(encodingId, muxingId, body),
				list: (query: StampPageQuery) => api.list(encodingId, muxingId, query),
				customData: (id: string) =>
					api.customdata.get(encodingId, muxingId, id),
			};
		}
		case "WEBM": {
			const api = m.webm.drm.speke;
			return {
				create: (body: SpekeDrm) => api.create(encodingId, muxingId, body),
				list: (query: StampPageQuery) => api.list(encodingId, muxingId, query),
				customData: (id: string) =>
					api.customdata.get(encodingId, muxingId, id),
			};
		}
		case "PROGRESSIVE_WEBM": {
			const api = m.progressiveWebm.drm.speke;
			return {
				create: (body: SpekeDrm) => api.create(encodingId, muxingId, body),
				list: (query: StampPageQuery) => api.list(encodingId, muxingId, query),
				customData: (id: string) =>
					api.customdata.get(encodingId, muxingId, id),
			};
		}
		default:
			throw new Error(`SPEKE DRM is not supported on ${kind} muxings`);
	}
}
function cencApiFor(
	m: Muxings,
	kind: string,
	encodingId: string,
	muxingId: string,
) {
	switch (kind) {
		case "FMP4": {
			const api = m.fmp4.drm.cenc;
			return {
				create: (body: CencDrm) => api.create(encodingId, muxingId, body),
				list: (query: StampPageQuery) => api.list(encodingId, muxingId, query),
				customData: (id: string) =>
					api.customdata.get(encodingId, muxingId, id),
			};
		}
		case "MP4": {
			const api = m.mp4.drm.cenc;
			return {
				create: (body: CencDrm) => api.create(encodingId, muxingId, body),
				list: (query: StampPageQuery) => api.list(encodingId, muxingId, query),
				customData: (id: string) =>
					api.customdata.get(encodingId, muxingId, id),
			};
		}
		case "WEBM": {
			const api = m.webm.drm.cenc;
			return {
				create: (body: CencDrm) => api.create(encodingId, muxingId, body),
				list: (query: StampPageQuery) => api.list(encodingId, muxingId, query),
				customData: (id: string) =>
					api.customdata.get(encodingId, muxingId, id),
			};
		}
		case "PROGRESSIVE_WEBM": {
			const api = m.progressiveWebm.drm.cenc;
			return {
				create: (body: CencDrm) => api.create(encodingId, muxingId, body),
				list: (query: StampPageQuery) => api.list(encodingId, muxingId, query),
				customData: (id: string) =>
					api.customdata.get(encodingId, muxingId, id),
			};
		}
		default:
			throw new Error(`CENC DRM is not supported on ${kind} muxings`);
	}
}
function fairPlayApiFor(
	m: Muxings,
	kind: string,
	encodingId: string,
	muxingId: string,
) {
	switch (kind) {
		case "FMP4": {
			const api = m.fmp4.drm.fairplay;
			return {
				create: (body: FairPlayDrm) => api.create(encodingId, muxingId, body),
				list: (query: StampPageQuery) => api.list(encodingId, muxingId, query),
				customData: (id: string) =>
					api.customdata.get(encodingId, muxingId, id),
			};
		}
		case "TS": {
			const api = m.ts.drm.fairplay;
			return {
				create: (body: FairPlayDrm) => api.create(encodingId, muxingId, body),
				list: (query: StampPageQuery) => api.list(encodingId, muxingId, query),
				customData: (id: string) =>
					api.customdata.get(encodingId, muxingId, id),
			};
		}
		case "PROGRESSIVE_TS": {
			const api = m.progressiveTs.drm.fairplay;
			return {
				create: (body: FairPlayDrm) => api.create(encodingId, muxingId, body),
				list: (query: StampPageQuery) => api.list(encodingId, muxingId, query),
				customData: (id: string) =>
					api.customdata.get(encodingId, muxingId, id),
			};
		}
		default:
			throw new Error(`FairPlay DRM is not supported on ${kind} muxings`);
	}
}
export function createDrmOps(
	ctx: OpsContext,
): Pick<
	SdkOps,
	"createCencDrm" | "createFairPlayDrm" | "createSpekeDrm" | "listMuxingDrm"
> {
	const { audited, stampAuditAdopt, id, muxings, options } = ctx;
	return {
		createCencDrm: (encodingId, muxingId, p) => {
			const cencApi = cencApiFor(muxings(), p.muxingKind, encodingId, muxingId);
			const drmPath = p.muxingKind.toLowerCase().replaceAll("_", "-");
			return adoptOrCreateStamped({
				label: "CENC DRM",
				stamp: options.stamp,
				lookup: (expect) =>
					findStampedResource({
						label: "CENC DRM",
						expect,
						list: cencApi.list,
						customData: cencApi.customData,
					}),
				auditAdopt: stampAuditAdopt(
					`/encoding/encodings/${encodingId}/muxings/${drmPath}/${muxingId}/drm/cenc`,
				),
				create: () =>
					audited(
						"POST",
						`/encoding/encodings/${encodingId}/muxings/${drmPath}/${muxingId}/drm/cenc`,
						// key is the content key — never snapshot it. kid/PSSH/laUrl/
						// FairPlay iv+uri are public manifest material.
						{
							muxingKind: p.muxingKind,
							kid: p.kid,
							encryptionMode: p.encryptionMode,
							ivSize: p.ivSize,
							widevine: p.widevine,
							playReady: p.playReady,
							fairPlay: p.fairPlay,
							outputPath: p.destination?.outputPath,
							name: p.name,
						},
						() =>
							cencApi.create(
								new CencDrm({
									key: p.key,
									kid: p.kid,
									encryptionMode: optEnum(
										EncryptionMode,
										p.encryptionMode,
										"EncryptionMode",
									),
									ivSize: optEnum(IvSize, p.ivSize, "IvSize"),
									widevine: p.widevine
										? new CencWidevine({ pssh: p.widevine.pssh })
										: undefined,
									playReady: p.playReady
										? new CencPlayReady({
												laUrl: p.playReady.laUrl,
												pssh: p.playReady.pssh,
											})
										: undefined,
									fairPlay: p.fairPlay
										? new CencFairPlay({
												iv: p.fairPlay.iv,
												uri: p.fairPlay.uri,
											})
										: undefined,
									outputs: outputs(p.destination),
									name: p.name,
								}),
							),
						(r) => ({ id: r.id }),
					).then(id),
			});
		},

		createSpekeDrm: (encodingId, muxingId, p) => {
			const api = spekeApi(muxings(), p.muxingKind, encodingId, muxingId);
			const path = `/encoding/encodings/${encodingId}/muxings/${p.muxingKind.toLowerCase().replaceAll("_", "-")}/${muxingId}/drm/speke`;
			return adoptOrCreateStamped({
				label: "SPEKE DRM",
				stamp: options.stamp,
				lookup: (expect) =>
					findStampedResource({
						label: "SPEKE DRM",
						expect,
						list: api.list,
						customData: api.customData,
					}),
				auditAdopt: stampAuditAdopt(path),
				create: () =>
					audited(
						"POST",
						path,
						{
							contentId: p.contentId,
							kid: p.kid,
							iv: p.iv,
							systemIds: p.systemIds,
							providerConfigured: true,
							outputPath: p.destination?.outputPath,
							name: p.name,
						},
						() =>
							api
								.create(
									new SpekeDrm({
										contentId: p.contentId,
										kid: p.kid,
										iv: p.iv,
										systemIds: p.systemIds,
										provider: new SpekeDrmProvider({
											...p.provider,
											externalIdMode: optEnum(
												ExternalIdMode,
												p.provider.externalIdMode,
												"ExternalIdMode",
											),
										}),
										outputs: outputs(p.destination),
										name: p.name,
									}),
								)
								.catch((error: unknown) => {
									// A key service can echo the endpoint or authentication in its error.
									// Keep correlation metadata, but no provider prose or raw SDK body.
									if (isBitmovinError(error))
										throw Object.assign(
											new Error("SPEKE key provider creation failed"),
											{
												httpStatusCode: error.httpStatusCode,
												errorCode: error.errorCode,
												requestId: error.requestId,
												shortMessage: "SPEKE key provider creation failed",
											},
										);
									throw new Error("SPEKE key provider creation failed");
								}),
						(response) => ({ id: response.id }),
					).then(id),
			});
		},
		createFairPlayDrm: (encodingId, muxingId, p) => {
			const fairplayApi = fairPlayApiFor(
				muxings(),
				p.muxingKind,
				encodingId,
				muxingId,
			);
			const drmPath = p.muxingKind.toLowerCase().replaceAll("_", "-");
			return adoptOrCreateStamped({
				label: "FairPlay DRM",
				stamp: options.stamp,
				lookup: (expect) =>
					findStampedResource({
						label: "FairPlay DRM",
						expect,
						list: fairplayApi.list,
						customData: fairplayApi.customData,
					}),
				auditAdopt: stampAuditAdopt(
					`/encoding/encodings/${encodingId}/muxings/${drmPath}/${muxingId}/drm/fairplay`,
				),
				create: () =>
					audited(
						"POST",
						`/encoding/encodings/${encodingId}/muxings/${drmPath}/${muxingId}/drm/fairplay`,
						// key is the content key — never snapshot it.
						{
							muxingKind: p.muxingKind,
							iv: p.iv,
							uri: p.uri,
							outputPath: p.destination?.outputPath,
							name: p.name,
						},
						() =>
							fairplayApi.create(
								new FairPlayDrm({
									key: p.key,
									iv: p.iv,
									uri: p.uri,
									outputs: outputs(p.destination),
									name: p.name,
								}),
							),
						(r) => ({ id: r.id }),
					).then(id),
			});
		},

		listMuxingDrm: async (encodingId, muxingId, muxingKind, drmKind) => {
			if (muxingKind === "CMAF") {
				throw new Error("CMAF muxing DRM is not supported by the SDK");
			}
			const m = muxings();
			// C6: always paginate — a muxing realistically carries ≤3 DRMs,
			// but the hard rule admits no exceptions. SDK quirk: `limit`/
			// `offset` are typed string on some generated params and number
			// on others — same wire query either way, so each call gets the
			// literal its endpoint declares.
			const api =
				drmKind === "SPEKE"
					? spekeApi(m, muxingKind, encodingId, muxingId)
					: drmKind === "CENC"
						? cencApiFor(m, muxingKind, encodingId, muxingId)
						: fairPlayApiFor(m, muxingKind, encodingId, muxingId);
			const page = (offset: number) => api.list({ limit: 100, offset });
			const all: { id: string; outputPath?: string }[] = [];
			for (let offset = 0; ; offset += 100) {
				const response = await page(offset);
				const items = response.items ?? [];
				for (const drm of items) {
					if (!drm.id) {
						continue;
					}
					// Same first-of-many guard as listMuxings above: a DRM's `outputs` is
					// an array, and an encrypted rung whose DRM writes two distinct paths
					// has no single base path a manifest entry could reference.
					// Paths only, same rule as the muxing guard above (review of PR #152).
					const drmPaths = new Set(
						(drm.outputs ?? [])
							.map((o) => o.outputPath)
							.filter((path): path is string => typeof path === "string"),
					);
					if (drmPaths.size > 1) {
						throw new Error(
							`${drmKind} DRM ${drm.id} on ${muxingKind} muxing ${muxingId} writes ${drmPaths.size} distinct output paths — refusing to pick one and silently drop the other encrypted legs`,
						);
					}
					all.push({ id: drm.id, outputPath: drm.outputs?.[0]?.outputPath });
				}
				if (items.length < 100) {
					return all;
				}
			}
		},

		// --- live (P3-PR2) ---
	};
}
