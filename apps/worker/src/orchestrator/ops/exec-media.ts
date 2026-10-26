/**
 *  half 2: the media cases of executor.ts' 84-case switch,
 * moved VERBATIM. executor.ts keeps every case LABEL (grouped, so its
 * `never` default still proves exhaustiveness and the freeze scan still
 * reads all 84) and dispatches here; this switch narrows the same way the
 * monolithic one did. The default is unreachable by construction.
 */
import type { CompiledOperation } from "@bitovp/core";
import { filterParameters, mediaFilterSchema } from "@bitovp/core";
import type { StepResult } from "../executor";
import type { ExecStepContext } from "./exec-shared";
import {
	destinationOf,
	num,
	numList,
	optBool,
	optNum,
	optRefId,
	optStr,
	refId,
	refIdList,
	str,
} from "./exec-shared";
import { signWatermarkImage } from "./watermark-image";

export async function executeMediaStep(
	op: CompiledOperation,
	ec: ExecStepContext,
): Promise<StepResult> {
	const { ctx, request } = ec;
	const p = op.payload;
	switch (op.kind) {
		case "CREATE_INGEST_INPUT_STREAM": {
			const resourceId = await ctx.sdk.createIngestInputStream(
				refId(op, ctx, "encodingId"),
				{
					inputId: refId(op, ctx, "inputId"),
					inputPath: str(p.inputPath),
					selectionMode: str(p.selectionMode),
					position: num(p.position, 0),
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_BURN_IN_SRT": {
			const resourceId = await ctx.sdk.createBurnInSrt(
				refId(op, ctx, "encodingId"),
				refId(op, ctx, "streamId"),
				{
					inputId: refId(op, ctx, "inputId"),
					inputPath: str(p.inputPath),
					characterEncoding: str(p.characterEncoding),
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}
		case "CREATE_FILE_INPUT_STREAM": {
			const resourceId = await ctx.sdk.createFileInputStream(
				refId(op, ctx, "encodingId"),
				{
					inputId: refId(op, ctx, "inputId"),
					inputPath: str(p.inputPath),
					fileType: str(p.fileType),
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_DOLBY_ATMOS_INPUT_STREAM": {
			const resourceId = await ctx.sdk.createDolbyAtmosInputStream(
				refId(op, ctx, "encodingId"),
				{
					inputId: refId(op, ctx, "inputId"),
					inputPath: str(p.inputPath),
					inputFormat: str(p.inputFormat),
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_DOLBY_VISION_INPUT_STREAM": {
			const resourceId = await ctx.sdk.createDolbyVisionInputStream(
				refId(op, ctx, "encodingId"),
				{
					inputId: refId(op, ctx, "inputId"),
					videoInputPath: str(p.videoInputPath),
					metadataInputPath: optStr(p.metadataInputPath),
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_DOLBY_VISION_METADATA_INPUT_STREAM": {
			const resourceId = await ctx.sdk.createDolbyVisionMetadataInputStream(
				refId(op, ctx, "encodingId"),
				{
					inputId: refId(op, ctx, "inputId"),
					inputPath: str(p.inputPath),
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_TRIMMING_TIME_BASED": {
			const resourceId = await ctx.sdk.createTimeBasedTrimmingInputStream(
				refId(op, ctx, "encodingId"),
				{
					inputStreamId: refId(op, ctx, "inputStreamId"),
					offset: optNum(p.offset),
					duration: optNum(p.duration),
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_TRIMMING_TIMECODE_TRACK": {
			const resourceId = await ctx.sdk.createTimecodeTrackTrimmingInputStream(
				refId(op, ctx, "encodingId"),
				{
					inputStreamId: refId(op, ctx, "inputStreamId"),
					startTimeCode: optStr(p.startTimeCode),
					endTimeCode: optStr(p.endTimeCode),
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_TRIMMING_H264_PICTURE_TIMING": {
			const resourceId =
				await ctx.sdk.createH264PictureTimingTrimmingInputStream(
					refId(op, ctx, "encodingId"),
					{
						inputStreamId: refId(op, ctx, "inputStreamId"),
						startPicTiming: optStr(p.startPicTiming),
						endPicTiming: optStr(p.endPicTiming),
					},
				);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_AUDIO_MIX_INPUT_STREAM": {
			const channels = p.audioMixChannels as Array<{
				sourceRef: string;
				outputChannelType: string;
				outputChannelNumber?: number;
				sourceChannels: Array<{
					type: string;
					channelNumber?: number;
					gain?: number;
				}>;
			}>;
			const resourceId = await ctx.sdk.createAudioMixInputStream(
				refId(op, ctx, "encodingId"),
				{
					...(p.channelLayout === undefined
						? {}
						: { channelLayout: str(p.channelLayout) }),
					audioMixChannels: channels.map(({ sourceRef, ...c }) => ({
						...c,
						inputStreamId: refId(op, ctx, sourceRef),
					})),
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}
		case "CREATE_CONCATENATION_INPUT_STREAM": {
			// Each source carries `sourceRef` naming the refs key holding its
			// resolved input-stream id (compiler zip contract); order is the
			// payload order, mirrored into ConcatenationInputConfiguration[].
			const rawSources = Array.isArray(p.sources) ? p.sources : [];
			const sources = rawSources.map((entry) => {
				const s = (entry ?? {}) as {
					sourceRef?: unknown;
					isMain?: unknown;
					position?: unknown;
					paddingBefore?: unknown;
					paddingAfter?: unknown;
					aspectMode?: unknown;
				};
				const padding = (value: unknown) => {
					if (!value || typeof value !== "object") {
						return undefined;
					}
					const seq = value as { duration?: unknown; unit?: unknown };
					return {
						duration: num(seq.duration, 0),
						unit: optStr(seq.unit),
					};
				};
				return {
					inputStreamId: refId(op, ctx, str(s.sourceRef)),
					isMain: optBool(s.isMain),
					position: optNum(s.position),
					paddingBefore: padding(s.paddingBefore),
					paddingAfter: padding(s.paddingAfter),
					aspectMode: optStr(s.aspectMode),
				};
			});
			const resourceId = await ctx.sdk.createConcatenationInputStream(
				refId(op, ctx, "encodingId"),
				{ sources },
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_STREAM": {
			// Live streams reference the input directly (refs.inputId + inputPath
			// + position); VOD/file streams reference a pre-built IngestInputStream
			// (refs.inputStreamId). Exactly one ref is present per op (C13).
			const resourceId = await ctx.sdk.createStream(
				refId(op, ctx, "encodingId"),
				{
					codecConfigId: refId(op, ctx, "codecConfigId"),
					inputStreamId: op.refs.inputStreamId
						? refId(op, ctx, "inputStreamId")
						: undefined,
					inputId: op.refs.inputId ? refId(op, ctx, "inputId") : undefined,
					inputPath: typeof p.inputPath === "string" ? p.inputPath : undefined,
					position: typeof p.position === "number" ? p.position : undefined,
					name: str(p.name),
					mode: str(p.mode),
					conditions: p.conditions as
						| { attribute: string; operator: string; value: string }
						| undefined,
					perTitleSettings: p.perTitleSettings as
						| Record<string, unknown>
						| undefined,
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_STREAM_HDR_DOLBY_VISION": {
			const resourceId = await ctx.sdk.createDolbyVisionStreamHdr(
				refId(op, ctx, "encodingId"),
				refId(op, ctx, "streamId"),
				{
					profile: str(p.profile),
					metadataSource: str(p.metadataSource),
					metadataInputStreamId: optRefId(op, ctx, "metadataInputStreamId"),
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_FILTER_DENOISE_HQDN3D":
		case "CREATE_FILTER_UNSHARP":
		case "CREATE_FILTER_CROP":
		case "CREATE_FILTER_SCALE":
		case "CREATE_FILTER_ROTATE":
		case "CREATE_FILTER_WATERMARK":
		case "CREATE_FILTER_TEXT":
		case "CREATE_FILTER_AUDIO_VOLUME":
		case "CREATE_FILTER_EBU_R128_SINGLE_PASS": {
			const { imageInput, ...parameters } = p;
			const filter = mediaFilterSchema.parse({
				...parameters,
				key: "filter",
				kind: op.kind.replace("CREATE_FILTER_", ""),
			});
			const payload = filterParameters(filter);
			if (filter.kind === "WATERMARK") {
				delete payload.inputKey;
				delete payload.imagePath;
				payload.image = await signWatermarkImage(
					imageInput,
					filter.imagePath,
					ctx.resolveCredential,
				);
			}
			const resourceId = await ctx.sdk.createMediaFilter(filter.kind, payload);
			return { resourceId, request, response: { id: resourceId } };
		}
		case "CREATE_FILTER_DEINTERLACE": {
			const resourceId = await ctx.sdk.createDeinterlaceFilter({
				parity: str(p.parity),
				mode: str(p.mode),
				frameSelectionMode: str(p.frameSelectionMode),
				autoEnable: str(p.autoEnable),
			});
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_STREAM_FILTERS": {
			// positions[i] pairs with filterIds[i] — compiler contract.
			const filterIds = refIdList(op, ctx, "filterIds") ?? [];
			const positions = numList(p.positions);
			if (filterIds.length !== positions.length) {
				throw new Error(
					`step "${op.step}" has ${filterIds.length} filters but ${positions.length} positions`,
				);
			}
			const filters = filterIds.map((id, i) => ({
				id,
				position: positions[i] as number,
			}));
			await ctx.sdk.createStreamFilters(
				refId(op, ctx, "encodingId"),
				refId(op, ctx, "streamId"),
				filters,
			);
			return { request, response: { attached: filters.length } };
		}

		case "CREATE_KEYFRAME": {
			const resourceId = await ctx.sdk.createKeyframe(
				refId(op, ctx, "encodingId"),
				{ time: num(p.time, 0) },
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_THUMBNAIL": {
			const destination = destinationOf(op, ctx);
			if (!destination) {
				throw new Error(`step "${op.step}" needs an output destination`);
			}
			const resourceId = await ctx.sdk.createThumbnail(
				refId(op, ctx, "encodingId"),
				refId(op, ctx, "streamId"),
				{
					height: num(p.height, 0),
					pattern: str(p.pattern),
					unit: str(p.unit),
					positions: numList(p.positions),
					destination,
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_SPRITE": {
			const destination = destinationOf(op, ctx);
			if (!destination) {
				throw new Error(`step "${op.step}" needs an output destination`);
			}
			const resourceId = await ctx.sdk.createSprite(
				refId(op, ctx, "encodingId"),
				refId(op, ctx, "streamId"),
				{
					width: optNum(p.width),
					height: optNum(p.height),
					distance: num(p.distance, 0),
					unit: str(p.unit),
					hTiles: optNum(p.hTiles),
					vTiles: optNum(p.vTiles),
					imagesPerFile: optNum(p.imagesPerFile),
					spriteName: optStr(p.spriteName),
					filename: str(p.filename),
					vttName: optStr(p.vttName),
					creationMode: optStr(p.creationMode),
					name: optStr(p.name),
					destination,
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_MUXING_CMAF": {
			const resourceId = await ctx.sdk.createCmafMuxing(
				refId(op, ctx, "encodingId"),
				{
					streamId: refId(op, ctx, "streamId"),
					segmentLength: num(p.segmentLength, 6),
					segmentNaming: optStr(p.segmentNaming),
					segmentNamingTemplate: optStr(p.segmentNamingTemplate),
					initSegmentName: optStr(p.initSegmentName),
					initSegmentNameTemplate: optStr(p.initSegmentNameTemplate),
					framesPerCmafChunk: optNum(p.framesPerCmafChunk),
					destination: destinationOf(op, ctx),
					name: optStr(p.name),
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_MUXING_FMP4": {
			const resourceId = await ctx.sdk.createFmp4Muxing(
				refId(op, ctx, "encodingId"),
				{
					streamId: refId(op, ctx, "streamId"),
					segmentLength: num(p.segmentLength, 6),
					/*
					 * `optStr`, NOT `str` (WP-C6, 2026-09-02). Pinned on the TS and
					 * fMP4 arms — the only two whose schema carries
					 * `segmentNamingTemplate`; on WEBM/CHUNKED_TEXT it is
					 * defensive (those schemas default `segmentNaming` to a
					 * literal, so no template can reach them today). The
					 * compiler omits the literal whenever the plan
					 * carries a template, and `str` turned that absence into `""`
					 * — an EMPTY segmentNaming sent beside segmentNamingTemplate,
					 * which the SDK forbids ("If segmentNamingTemplate is set,
					 * segmentNaming must not be set"). The SDK's Mapper passes ""
					 * through and JSON.stringify keeps it. Every Akamai MSL
					 * template arm ever run (2026-08-21) went through this line.
					 */
					segmentNaming: optStr(p.segmentNaming),
					// Bitmovin expands {rand_chars:x} here and copies the result
					// into segmentNaming; the compiler sends only one of the two.
					segmentNamingTemplate: optStr(p.segmentNamingTemplate),
					initSegmentName: str(p.initSegmentName),
					destination: destinationOf(op, ctx),
					name: optStr(p.name),
					// C14: present in the payload only when ad markers are enabled.
					signalScte35AsEmsg: optBool(p.signalScte35AsEmsg),
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_MUXING_PROGRESSIVE_WEBM": {
			const resourceId = await ctx.sdk.createProgressiveWebmMuxing(
				refId(op, ctx, "encodingId"),
				{
					streamId: refId(op, ctx, "streamId"),
					filename: str(p.filename),
					destination: destinationOf(op, ctx),
					name: optStr(p.name),
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_MUXING_MP4": {
			const dolbyVision = p.dolbyVisionConfiguration as
				| { trackSampleEntryName?: string }
				| undefined;
			const resourceId = await ctx.sdk.createMp4Muxing(
				refId(op, ctx, "encodingId"),
				{
					streamId: refId(op, ctx, "streamId"),
					// refIdList tolerates the ref being absent (every single-stream
					// container) and throws on one that names an uncreated step —
					// which is the failure a muxed container must NOT reach the API
					// with, since Bitmovin would accept a half-built muxing.
					additionalStreamIds: refIdList(op, ctx, "additionalStreamIds"),
					filename: str(p.filename),
					fragmentDuration: optNum(p.fragmentDuration),
					fragmentedMP4MuxingManifestType: optStr(
						p.fragmentedMP4MuxingManifestType,
					),
					dolbyVisionTrackSampleEntryName: optStr(
						dolbyVision?.trackSampleEntryName,
					),
					destination: destinationOf(op, ctx),
					name: optStr(p.name),
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_MUXING_TS": {
			const resourceId = await ctx.sdk.createTsMuxing(
				refId(op, ctx, "encodingId"),
				{
					streamId: refId(op, ctx, "streamId"),
					additionalStreamIds: refIdList(op, ctx, "additionalStreamIds"),
					segmentLength: num(p.segmentLength, 6),
					segmentNaming: optStr(p.segmentNaming),
					// Bitmovin expands {rand_chars:x} here and copies the result
					// into segmentNaming; the compiler sends only one of the two.
					segmentNamingTemplate: optStr(p.segmentNamingTemplate),
					destination: destinationOf(op, ctx),
					name: optStr(p.name),
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_MUXING_WEBM": {
			const resourceId = await ctx.sdk.createWebmMuxing(
				refId(op, ctx, "encodingId"),
				{
					streamId: refId(op, ctx, "streamId"),
					segmentLength: num(p.segmentLength, 6),
					segmentNaming: optStr(p.segmentNaming),
					// Bitmovin expands {rand_chars:x} here and copies the result
					// into segmentNaming; the compiler sends only one of the two.
					segmentNamingTemplate: optStr(p.segmentNamingTemplate),
					initSegmentName: str(p.initSegmentName),
					destination: destinationOf(op, ctx),
					name: optStr(p.name),
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_MUXING_TEXT": {
			const resourceId = await ctx.sdk.createTextMuxing(
				refId(op, ctx, "encodingId"),
				{
					streamId: refId(op, ctx, "streamId"),
					filename: str(p.filename),
					destination: destinationOf(op, ctx),
					name: optStr(p.name),
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}
		case "CREATE_MUXING_CHUNKED_TEXT": {
			const resourceId = await ctx.sdk.createChunkedTextMuxing(
				refId(op, ctx, "encodingId"),
				{
					streamId: refId(op, ctx, "streamId"),
					segmentLength: num(p.segmentLength, 6),
					segmentNaming: optStr(p.segmentNaming),
					// Bitmovin expands {rand_chars:x} here and copies the result
					// into segmentNaming; the compiler sends only one of the two.
					segmentNamingTemplate: optStr(p.segmentNamingTemplate),
					destination: destinationOf(op, ctx),
					name: optStr(p.name),
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}
		default:
			throw new Error(
				`executeMediaStep: unhandled kind ${String(op.kind)} — the executor dispatch and this switch have diverged`,
			);
	}
}
