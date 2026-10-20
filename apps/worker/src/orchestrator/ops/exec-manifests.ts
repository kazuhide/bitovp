/**
 *  half 2: the manifests cases of executor.ts' 84-case switch,
 * moved VERBATIM. executor.ts keeps every case LABEL (grouped, so its
 * `never` default still proves exhaustiveness and the freeze scan still
 * reads all 84) and dispatches here; this switch narrows the same way the
 * monolithic one did. The default is unreachable by construction.
 */
import type { CompiledOperation } from "@bitovp/core";
import type { StepResult } from "../executor";
import type { ExecStepContext } from "./exec-shared";
import {
	avMuxingKindOf,
	awaitTask,
	destinationOf,
	joinFilePath,
	listPerTitleMuxings,
	optBool,
	optNum,
	optRefId,
	optStr,
	refId,
	str,
	stripBasePath,
} from "./exec-shared";

export async function executeManifestStep(
	op: CompiledOperation,
	ec: ExecStepContext,
): Promise<StepResult> {
	const { ctx, request, startedDuringCrashWindow } = ec;
	const p = op.payload;
	switch (op.kind) {
		case "CREATE_MANIFEST_HLS": {
			const destination = destinationOf(op, ctx);
			if (!destination) {
				throw new Error(`step "${op.step}" needs an output destination`);
			}
			const resourceId = await ctx.sdk.createHlsManifest({
				manifestName: str(p.manifestName),
				name: str(p.name),
				masterVersion: optStr(p.hlsMasterPlaylistVersion),
				mediaVersion: optStr(p.hlsMediaPlaylistVersion),
				destination,
			});
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_HLS_AUDIO_MEDIA": {
			const resourceId = await ctx.sdk.createHlsAudioMedia(
				refId(op, ctx, "manifestId"),
				{
					name: str(p.name),
					groupId: str(p.groupId),
					language: str(p.language),
					isDefault: optBool(p.isDefault),
					autoselect: optBool(p.autoselect),
					segmentPath: str(p.segmentPath),
					uri: str(p.uri),
					encodingId: refId(op, ctx, "encodingId"),
					streamId: refId(op, ctx, "streamId"),
					muxingId: refId(op, ctx, "muxingId"),
					drmId: optRefId(op, ctx, "drmId"),
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_HLS_STREAM_INFO": {
			const resourceId = await ctx.sdk.createHlsStreamInfo(
				refId(op, ctx, "manifestId"),
				{
					// `optStr`, NOT `str`: the
					// compiler OMITS `audio` on a self-contained muxed-TS variant (C33 —
					// there is no EXT-X-MEDIA group to point at), and `str(undefined)`
					// turned that omission into `AUDIO=""` on the wire. Verified against
					// the installed SDK: `new StreamInfo({ audio: undefined })`
					// serializes WITHOUT the key; `""` serializes as `"audio":""`, and
					// the API doc on the field says it MUST match a GROUP-ID.
					audio: optStr(p.audio),
					subtitles: optStr(p.subtitles),
					closedCaptions: str(p.closedCaptions),
					segmentPath: str(p.segmentPath),
					uri: str(p.uri),
					encodingId: refId(op, ctx, "encodingId"),
					streamId: refId(op, ctx, "streamId"),
					muxingId: refId(op, ctx, "muxingId"),
					drmId: optRefId(op, ctx, "drmId"),
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_HLS_SUBTITLES_MEDIA": {
			const resourceId = await ctx.sdk.createHlsSubtitlesMedia(
				refId(op, ctx, "manifestId"),
				{
					name: str(p.name),
					groupId: str(p.groupId),
					language: str(p.language),
					segmentPath: str(p.segmentPath),
					uri: str(p.uri),
					encodingId: refId(op, ctx, "encodingId"),
					streamId: refId(op, ctx, "streamId"),
					muxingId: refId(op, ctx, "muxingId"),
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_HLS_IFRAME_PLAYLIST": {
			const resourceId = await ctx.sdk.createHlsIframePlaylist(
				refId(op, ctx, "manifestId"),
				refId(op, ctx, "streamInfoId"),
				{ filename: str(p.filename) },
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_HLS_PER_TITLE_VARIANTS": {
			const manifestId = refId(op, ctx, "manifestId");
			const encodingId = refId(op, ctx, "encodingId");
			const uriTemplate = str(p.uriTemplate);
			const stripBase = str(p.stripBase);
			const streamInfoIds: string[] = [];
			const rows = await listPerTitleMuxings(op, ctx, encodingId);
			if (rows.length === 0) {
				// A green job with an empty master playlist/manifest is the
				// silent-failure mode this codebase bans — fail loud instead.
				throw new Error(
					`step "${op.step}": no ${str(op.payload.streamModeFilter)} ${str(op.payload.muxingKind)} muxings matched — nothing to add to the manifest`,
				);
			}
			for (const row of rows) {
				let uri = uriTemplate;
				if (uri.includes("{avgBitrate}")) {
					if (row.muxing.avgBitrate === undefined) {
						throw new Error(
							`step "${op.step}": muxing ${row.muxing.id} has no avgBitrate for uri template`,
						);
					}
					uri = uri.replaceAll("{avgBitrate}", String(row.muxing.avgBitrate));
				}
				if (uri.includes("{codecBitrate}")) {
					const bitrate = await ctx.sdk.getVideoConfigBitrate(
						row.codecConfigId,
					);
					if (bitrate === undefined) {
						throw new Error(
							`step "${op.step}": codec config ${row.codecConfigId} has no bitrate for uri template`,
						);
					}
					uri = uri.replaceAll("{codecBitrate}", String(bitrate));
				}
				streamInfoIds.push(
					await ctx.sdk.createHlsStreamInfo(manifestId, {
						// Same rule as the static variant above (HIGH-8).
						audio: optStr(p.audio),
						subtitles: optStr(p.subtitles),
						closedCaptions: str(p.closedCaptions),
						segmentPath: stripBasePath(row.basePath, stripBase),
						uri,
						encodingId,
						streamId: row.muxing.streamId,
						muxingId: row.muxing.id,
						drmId: row.drmId,
					}),
				);
			}
			return {
				request,
				response: { created: streamInfoIds.length, streamInfoIds },
			};
		}

		case "CREATE_MANIFEST_DASH": {
			const destination = destinationOf(op, ctx);
			if (!destination) {
				throw new Error(`step "${op.step}" needs an output destination`);
			}
			const resourceId = await ctx.sdk.createDashManifest({
				manifestName: str(p.manifestName),
				name: str(p.name),
				profile: optStr(p.profile),
				destination,
			});
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_DASH_PERIOD": {
			const resourceId = await ctx.sdk.createDashPeriod(
				refId(op, ctx, "manifestId"),
				optNum(p.start),
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_DASH_ADAPTATION_SET_SUBTITLE": {
			const resourceId = await ctx.sdk.createDashSubtitleAdaptationSet(
				refId(op, ctx, "manifestId"),
				refId(op, ctx, "periodId"),
				{
					lang: str(p.lang),
					labels: p.labels as { value: string }[] | undefined,
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}
		case "CREATE_DASH_REPRESENTATION_IMSC": {
			const resourceId = await ctx.sdk.createDashImscRepresentation(
				refId(op, ctx, "manifestId"),
				refId(op, ctx, "periodId"),
				refId(op, ctx, "adaptationSetId"),
				{ imscUrl: str(p.imscUrl) },
			);
			return { resourceId, request, response: { id: resourceId } };
		}
		case "CREATE_DASH_REPRESENTATION_CHUNKED_TEXT": {
			const resourceId = await ctx.sdk.createDashChunkedTextRepresentation(
				refId(op, ctx, "manifestId"),
				refId(op, ctx, "periodId"),
				refId(op, ctx, "adaptationSetId"),
				{
					type: str(p.type),
					segmentPath: str(p.segmentPath),
					encodingId: refId(op, ctx, "encodingId"),
					muxingId: refId(op, ctx, "muxingId"),
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}
		case "CREATE_DASH_ADAPTATION_SET_VIDEO": {
			const resourceId = await ctx.sdk.createDashVideoAdaptationSet(
				refId(op, ctx, "manifestId"),
				refId(op, ctx, "periodId"),
				{ labels: p.labels as { value: string }[] | undefined },
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_DASH_ADAPTATION_SET_AUDIO": {
			const resourceId = await ctx.sdk.createDashAudioAdaptationSet(
				refId(op, ctx, "manifestId"),
				refId(op, ctx, "periodId"),
				{
					lang: optStr(p.lang),
					labels: p.labels as { value: string }[] | undefined,
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_DASH_REPRESENTATION_CMAF": {
			const resourceId = await ctx.sdk.createDashCmafRepresentation(
				refId(op, ctx, "manifestId"),
				refId(op, ctx, "periodId"),
				refId(op, ctx, "adaptationSetId"),
				{
					type: str(p.type),
					mode: optStr(p.mode),
					segmentPath: str(p.segmentPath),
					encodingId: refId(op, ctx, "encodingId"),
					muxingId: refId(op, ctx, "muxingId"),
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_DASH_REPRESENTATION_FMP4": {
			const resourceId = await ctx.sdk.createDashFmp4Representation(
				refId(op, ctx, "manifestId"),
				refId(op, ctx, "periodId"),
				refId(op, ctx, "adaptationSetId"),
				{
					type: str(p.type),
					mode: optStr(p.mode),
					segmentPath: str(p.segmentPath),
					encodingId: refId(op, ctx, "encodingId"),
					muxingId: refId(op, ctx, "muxingId"),
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_DASH_REPRESENTATION_WEBM": {
			// Static WebM representation. The facade
			// method already existed for the per-title expansion; the compiler
			// simply never emitted a static op for it.
			const resourceId = await ctx.sdk.createDashWebmRepresentation(
				refId(op, ctx, "manifestId"),
				refId(op, ctx, "periodId"),
				refId(op, ctx, "adaptationSetId"),
				{
					type: str(p.type),
					segmentPath: str(p.segmentPath),
					encodingId: refId(op, ctx, "encodingId"),
					muxingId: refId(op, ctx, "muxingId"),
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_DASH_REPRESENTATION_MP4": {
			const resourceId = await ctx.sdk.createDashMp4Representation(
				refId(op, ctx, "manifestId"),
				refId(op, ctx, "periodId"),
				refId(op, ctx, "adaptationSetId"),
				{
					type: str(p.type),
					filePath: str(p.filePath),
					encodingId: refId(op, ctx, "encodingId"),
					muxingId: refId(op, ctx, "muxingId"),
					...(op.refs.drmId ? { drmId: refId(op, ctx, "drmId") } : {}),
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_DASH_CONTENT_PROTECTION": {
			// The compiler names the representation endpoint that owns the child
			// (fmp4 vs webm — the URL differs); absent means FMP4, which is every
			// golden written before static WebM representations existed.
			const resourceId = await ctx.sdk.createDashContentProtection(
				{
					manifestId: refId(op, ctx, "manifestId"),
					periodId: refId(op, ctx, "periodId"),
					adaptationSetId: refId(op, ctx, "adaptationSetId"),
					representationId: refId(op, ctx, "representationId"),
					representationKind:
						optStr(p.representationKind) === "WEBM" ? "WEBM" : "FMP4",
				},
				{
					drmId: refId(op, ctx, "drmId"),
					encodingId: refId(op, ctx, "encodingId"),
					muxingId: refId(op, ctx, "muxingId"),
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_DASH_PER_TITLE_REPRESENTATIONS": {
			const manifestId = refId(op, ctx, "manifestId");
			const periodId = refId(op, ctx, "periodId");
			const adaptationSetId = refId(op, ctx, "adaptationSetId");
			const encodingId = refId(op, ctx, "encodingId");
			const muxingKind = avMuxingKindOf(op);
			const stripBase = str(p.stripBase);
			const representationIds: string[] = [];
			const rows = await listPerTitleMuxings(op, ctx, encodingId);
			if (rows.length === 0) {
				// A green job with an empty master playlist/manifest is the
				// silent-failure mode this codebase bans — fail loud instead.
				throw new Error(
					`step "${op.step}": no ${str(op.payload.streamModeFilter)} ${str(op.payload.muxingKind)} muxings matched — nothing to add to the manifest`,
				);
			}
			for (const row of rows) {
				const segmentPath = stripBasePath(row.basePath, stripBase);
				const representationId =
					muxingKind === "WEBM"
						? await ctx.sdk.createDashWebmRepresentation(
								manifestId,
								periodId,
								adaptationSetId,
								{
									type: str(p.type),
									segmentPath,
									encodingId,
									muxingId: row.muxing.id,
								},
							)
						: await (muxingKind === "CMAF"
								? ctx.sdk.createDashCmafRepresentation
								: ctx.sdk.createDashFmp4Representation)(
								manifestId,
								periodId,
								adaptationSetId,
								{
									type: str(p.type),
									mode: optStr(p.mode),
									segmentPath,
									encodingId,
									muxingId: row.muxing.id,
								},
							);
				representationIds.push(representationId);
				if (row.drmId) {
					await ctx.sdk.createDashContentProtection(
						{
							manifestId,
							periodId,
							adaptationSetId,
							representationId,
							representationKind: muxingKind === "WEBM" ? "WEBM" : "FMP4",
						},
						{
							drmId: row.drmId,
							encodingId,
							muxingId: row.muxing.id,
						},
					);
				}
			}
			return {
				request,
				response: { created: representationIds.length, representationIds },
			};
		}

		case "CREATE_MANIFEST_SMOOTH": {
			const destination = destinationOf(op, ctx);
			if (!destination) {
				throw new Error(`step "${op.step}" needs an output destination`);
			}
			const resourceId = await ctx.sdk.createSmoothManifest({
				serverManifestName: str(p.serverManifestName),
				clientManifestName: str(p.clientManifestName),
				name: str(p.name),
				destination,
			});
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_SMOOTH_REPRESENTATION_MP4": {
			const resourceId = await ctx.sdk.createSmoothMp4Representation(
				refId(op, ctx, "manifestId"),
				{
					mediaFile: str(p.mediaFile),
					language: str(p.language),
					trackName: str(p.trackName),
					encodingId: refId(op, ctx, "encodingId"),
					muxingId: refId(op, ctx, "muxingId"),
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_SMOOTH_CONTENT_PROTECTION": {
			const resourceId = await ctx.sdk.createSmoothContentProtection(
				refId(op, ctx, "manifestId"),
				{
					drmId: refId(op, ctx, "drmId"),
					encodingId: refId(op, ctx, "encodingId"),
					muxingId: refId(op, ctx, "muxingId"),
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_SMOOTH_PER_TITLE_ENTRIES": {
			const manifestId = refId(op, ctx, "manifestId");
			const encodingId = refId(op, ctx, "encodingId");
			const stripBase = str(p.stripBase);
			const representationIds: string[] = [];
			const rows = await listPerTitleMuxings(op, ctx, encodingId);
			if (rows.length === 0) {
				// A green job with an empty master playlist/manifest is the
				// silent-failure mode this codebase bans — fail loud instead.
				throw new Error(
					`step "${op.step}": no ${str(op.payload.streamModeFilter)} ${str(op.payload.muxingKind)} muxings matched — nothing to add to the manifest`,
				);
			}
			for (const row of rows) {
				if (row.muxing.filename === undefined) {
					throw new Error(
						`step "${op.step}": MP4 muxing ${row.muxing.id} has no filename for the smooth mediaFile`,
					);
				}
				representationIds.push(
					await ctx.sdk.createSmoothMp4Representation(manifestId, {
						mediaFile: joinFilePath(
							stripBasePath(row.basePath, stripBase),
							row.muxing.filename,
						),
						language: str(p.language),
						trackName: str(p.trackName),
						encodingId,
						muxingId: row.muxing.id,
					}),
				);
				if (row.drmId) {
					await ctx.sdk.createSmoothContentProtection(manifestId, {
						drmId: row.drmId,
						encodingId,
						muxingId: row.muxing.id,
					});
				}
			}
			return {
				request,
				response: { created: representationIds.length, representationIds },
			};
		}

		case "START_MANIFEST_HLS": {
			const manifestId = refId(op, ctx, "manifestId");
			const already = await startedDuringCrashWindow(() =>
				ctx.sdk.getHlsManifestStatus(manifestId),
			);
			if (already) {
				return {
					request,
					response: { started: true, resumed: true, status: already.status },
				};
			}
			await ctx.sdk.startHlsManifest(manifestId, {
				manifestGenerator: optStr(p.manifestGenerator),
			});
			return { request, response: { started: true } };
		}

		case "AWAIT_MANIFEST_HLS": {
			const manifestId = refId(op, ctx, "manifestId");
			const task = await awaitTask(op, ctx, () =>
				ctx.sdk.getHlsManifestStatus(manifestId),
			);
			return { request, response: task };
		}

		case "START_MANIFEST_DASH": {
			const manifestId = refId(op, ctx, "manifestId");
			const already = await startedDuringCrashWindow(() =>
				ctx.sdk.getDashManifestStatus(manifestId),
			);
			if (already) {
				return {
					request,
					response: { started: true, resumed: true, status: already.status },
				};
			}
			await ctx.sdk.startDashManifest(manifestId, {
				manifestGenerator: optStr(p.manifestGenerator),
			});
			return { request, response: { started: true } };
		}

		case "AWAIT_MANIFEST_DASH": {
			const manifestId = refId(op, ctx, "manifestId");
			const task = await awaitTask(op, ctx, () =>
				ctx.sdk.getDashManifestStatus(manifestId),
			);
			return { request, response: task };
		}

		case "START_MANIFEST_SMOOTH": {
			const manifestId = refId(op, ctx, "manifestId");
			const already = await startedDuringCrashWindow(() =>
				ctx.sdk.getSmoothManifestStatus(manifestId),
			);
			if (already) {
				return {
					request,
					response: { started: true, resumed: true, status: already.status },
				};
			}
			await ctx.sdk.startSmoothManifest(manifestId, {
				manifestGenerator: optStr(p.manifestGenerator),
			});
			return { request, response: { started: true } };
		}

		case "AWAIT_MANIFEST_SMOOTH": {
			const manifestId = refId(op, ctx, "manifestId");
			const task = await awaitTask(op, ctx, () =>
				ctx.sdk.getSmoothManifestStatus(manifestId),
			);
			return { request, response: task };
		}
		default:
			throw new Error(
				`executeManifestStep: unhandled kind ${String(op.kind)} — the executor dispatch and this switch have diverged`,
			);
	}
}
