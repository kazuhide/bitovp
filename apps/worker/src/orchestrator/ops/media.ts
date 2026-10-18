/**
 * : media members extracted VERBATIM from sdk-ops.ts. The
 * Pick<SdkOps, …> return type restores the contextual typing the members had
 * inside the monolithic literal; facade-freeze.test.ts pins the union.
 */
import {
	AspectMode,
	AudioMixChannelType,
	AudioMixInputChannelLayout,
	AudioMixInputStream,
	AudioMixInputStreamChannel,
	AudioMixInputStreamSourceChannel,
	AudioMixSourceChannelType,
	BurnInSubtitleSrt,
	CaptionCharacterEncoding,
	ChunkedTextMuxing,
	CmafMuxing,
	ConcatenationInputConfiguration,
	ConcatenationInputStream,
	DeinterlaceAutoEnable,
	DeinterlaceFilter,
	DeinterlaceFrameSelectionMode,
	DeinterlaceMode,
	DolbyAtmosIngestInputStream,
	DolbyAtmosInputFormat,
	DolbyVisionInputStream,
	DolbyVisionMetadata,
	DolbyVisionMetadataIngestInputStream,
	DolbyVisionMetadataSource,
	DolbyVisionMuxingConfiguration,
	DolbyVisionProfile,
	DolbyVisionTrackSampleEntryName,
	FileInputStream,
	FileInputStreamType,
	Fmp4Muxing,
	FragmentedMp4MuxingManifestType,
	H264PictureTimingTrimmingInputStream,
	IngestInputStream,
	InputPath,
	Keyframe,
	Mp4Muxing,
	type Muxing,
	MuxingStream,
	PaddingDurationUnit,
	PaddingSequence,
	PictureFieldParity,
	ProgressiveWebmMuxing,
	Sprite,
	SpriteCreationMode,
	SpriteUnit,
	Stream,
	StreamFilter,
	StreamInput,
	StreamMode,
	StreamSelectionMode,
	TextMuxing,
	Thumbnail,
	ThumbnailUnit,
	TimeBasedTrimmingInputStream,
	TimecodeTrackTrimmingInputStream,
	TsMuxing,
	WebmMuxing,
} from "@bitmovin/api-sdk";
import type { MuxingSummary, PaddingSequenceParams, SdkOps } from "../sdk-ops";
import type { OpsContext } from "./context";
import { createMediaFilter } from "./media-filters";
import {
	adoptOrCreateStamped,
	conditions,
	findStampedResource,
	optEnum,
	outputs,
	sdkEnumValue,
} from "./shared";

export function createMediaOps(
	ctx: OpsContext,
): Pick<
	SdkOps,
	| "createIngestInputStream"
	| "createFileInputStream"
	| "createDolbyAtmosInputStream"
	| "createDolbyVisionInputStream"
	| "createDolbyVisionMetadataInputStream"
	| "createTimeBasedTrimmingInputStream"
	| "createTimecodeTrackTrimmingInputStream"
	| "createH264PictureTimingTrimmingInputStream"
	| "createConcatenationInputStream"
	| "createAudioMixInputStream"
	| "createStream"
	| "createDolbyVisionStreamHdr"
	| "createDeinterlaceFilter"
	| "createBurnInSrt"
	| "createMediaFilter"
	| "createStreamFilters"
	| "createKeyframe"
	| "createThumbnail"
	| "createSprite"
	| "createCmafMuxing"
	| "createFmp4Muxing"
	| "createMp4Muxing"
	| "createProgressiveWebmMuxing"
	| "createTsMuxing"
	| "createWebmMuxing"
	| "createChunkedTextMuxing"
	| "createTextMuxing"
	| "listMuxings"
	| "getStreamContext"
	| "listEncodingStreams"
	| "listAllMuxings"
	| "listIngestInputStreams"
> {
	const { api, audited, stampAuditAdopt, id, muxings, capturePort, options } =
		ctx;
	/**
	 * Every stream that goes INTO one container, in wire order.
	 *
	 * `Muxing.streams` is a `MuxingStream[]` and always was; this layer wrote
	 * `[new MuxingStream({ streamId })]` — a one-element array literal — for
	 * every muxing kind, so a multiplexed container was unrepresentable no
	 * matter what the plan compiled to. Used by the two kinds whose schema can
	 * carry extra streams (TS, MP4); the other three creators keep their single
	 * literal, because nothing can currently hand them a second stream and a
	 * slot no input can reach is a coverage claim that is not true.
	 */
	const muxingStreams = (p: {
		streamId: string;
		additionalStreamIds?: string[];
	}): MuxingStream[] =>
		[p.streamId, ...(p.additionalStreamIds ?? [])].map(
			(streamId) => new MuxingStream({ streamId }),
		);
	return {
		createIngestInputStream: (encodingId, p) =>
			audited(
				"POST",
				`/encoding/encodings/${encodingId}/input-streams/ingest`,
				{ inputPath: p.inputPath, selectionMode: p.selectionMode },
				() =>
					api.encoding.encodings.inputStreams.ingest.create(
						encodingId,
						new IngestInputStream({
							inputId: p.inputId,
							inputPath: p.inputPath,
							selectionMode: sdkEnumValue(
								StreamSelectionMode,
								p.selectionMode,
								"StreamSelectionMode",
							),
							position: p.position,
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createFileInputStream: (encodingId, p) =>
			audited(
				"POST",
				`/encoding/encodings/${encodingId}/input-streams/file`,
				{ inputPath: p.inputPath, fileType: p.fileType },
				() =>
					api.encoding.encodings.inputStreams.file.create(
						encodingId,
						new FileInputStream({
							inputId: p.inputId,
							inputPath: p.inputPath,
							fileType: sdkEnumValue(
								FileInputStreamType,
								p.fileType,
								"FileInputStreamType",
							),
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createDolbyAtmosInputStream: (encodingId, p) =>
			audited(
				"POST",
				`/encoding/encodings/${encodingId}/input-streams/dolby-atmos`,
				{ inputPath: p.inputPath, inputFormat: p.inputFormat },
				() =>
					api.encoding.encodings.inputStreams.dolbyAtmos.create(
						encodingId,
						new DolbyAtmosIngestInputStream({
							inputId: p.inputId,
							inputPath: p.inputPath,
							inputFormat: sdkEnumValue(
								DolbyAtmosInputFormat,
								p.inputFormat,
								"DolbyAtmosInputFormat",
							),
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createDolbyVisionInputStream: (encodingId, p) =>
			audited(
				"POST",
				`/encoding/encodings/${encodingId}/input-streams/dolby-vision`,
				{
					videoInputPath: p.videoInputPath,
					metadataInputPath: p.metadataInputPath,
				},
				() =>
					api.encoding.encodings.inputStreams.dolbyVision.create(
						encodingId,
						new DolbyVisionInputStream({
							inputId: p.inputId,
							videoInputPath: p.videoInputPath,
							metadataInputPath: p.metadataInputPath,
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createDolbyVisionMetadataInputStream: (encodingId, p) =>
			audited(
				"POST",
				`/encoding/encodings/${encodingId}/input-streams/sidecar/dolby-vision-metadata-ingest`,
				{ inputPath: p.inputPath },
				() =>
					api.encoding.encodings.inputStreams.sidecar.dolbyVisionMetadataIngest.create(
						encodingId,
						new DolbyVisionMetadataIngestInputStream({
							inputId: p.inputId,
							inputPath: p.inputPath,
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createTimeBasedTrimmingInputStream: (encodingId, p) =>
			audited(
				"POST",
				`/encoding/encodings/${encodingId}/input-streams/trimming/time-based`,
				{ offset: p.offset, duration: p.duration },
				() =>
					api.encoding.encodings.inputStreams.trimming.timeBased.create(
						encodingId,
						new TimeBasedTrimmingInputStream({
							inputStreamId: p.inputStreamId,
							offset: p.offset,
							duration: p.duration,
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createTimecodeTrackTrimmingInputStream: (encodingId, p) =>
			audited(
				"POST",
				`/encoding/encodings/${encodingId}/input-streams/trimming/timecode-track`,
				{ startTimeCode: p.startTimeCode, endTimeCode: p.endTimeCode },
				() =>
					api.encoding.encodings.inputStreams.trimming.timecodeTrack.create(
						encodingId,
						new TimecodeTrackTrimmingInputStream({
							inputStreamId: p.inputStreamId,
							startTimeCode: p.startTimeCode,
							endTimeCode: p.endTimeCode,
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createH264PictureTimingTrimmingInputStream: (encodingId, p) =>
			audited(
				"POST",
				`/encoding/encodings/${encodingId}/input-streams/trimming/h264-picture-timing`,
				{ startPicTiming: p.startPicTiming, endPicTiming: p.endPicTiming },
				() =>
					api.encoding.encodings.inputStreams.trimming.h264PictureTiming.create(
						encodingId,
						new H264PictureTimingTrimmingInputStream({
							inputStreamId: p.inputStreamId,
							startPicTiming: p.startPicTiming,
							endPicTiming: p.endPicTiming,
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createAudioMixInputStream: (encodingId, p) => {
			const channelLayout = Object.values(AudioMixInputChannelLayout).find(
				(value) => value === p.channelLayout,
			);
			if (p.channelLayout !== undefined && channelLayout === undefined)
				throw new Error(
					`Unknown AudioMixInputChannelLayout "${p.channelLayout}"`,
				);
			const model = new AudioMixInputStream({
				channelLayout,
				audioMixChannels: p.audioMixChannels.map(
					(c) =>
						new AudioMixInputStreamChannel({
							...c,
							outputChannelType: sdkEnumValue(
								AudioMixChannelType,
								c.outputChannelType,
								"AudioMixChannelType",
							),
							sourceChannels: c.sourceChannels.map(
								(s) =>
									new AudioMixInputStreamSourceChannel({
										...s,
										type: sdkEnumValue(
											AudioMixSourceChannelType,
											s.type,
											"AudioMixSourceChannelType",
										),
									}),
							),
						}),
				),
			});
			return audited(
				"POST",
				`/encoding/encodings/${encodingId}/input-streams/audio-mix`,
				model,
				() =>
					api.encoding.encodings.inputStreams.audioMix.create(
						encodingId,
						model,
					),
				(r) => ({ id: r.id }),
			).then(id);
		},
		createConcatenationInputStream: (encodingId, p) => {
			const padding = (
				seq: PaddingSequenceParams | undefined,
			): PaddingSequence | undefined =>
				seq
					? new PaddingSequence({
							duration: seq.duration,
							unit: optEnum(
								PaddingDurationUnit,
								seq.unit,
								"PaddingDurationUnit",
							),
						})
					: undefined;
			return audited(
				"POST",
				`/encoding/encodings/${encodingId}/input-streams/concatenation`,
				{
					sources: p.sources.map((s) => ({
						inputStreamId: s.inputStreamId,
						isMain: s.isMain,
						position: s.position,
						paddingBefore: s.paddingBefore,
						paddingAfter: s.paddingAfter,
						aspectMode: s.aspectMode,
					})),
				},
				() =>
					api.encoding.encodings.inputStreams.concatenation.create(
						encodingId,
						new ConcatenationInputStream({
							concatenation: p.sources.map(
								(s) =>
									new ConcatenationInputConfiguration({
										inputStreamId: s.inputStreamId,
										isMain: s.isMain,
										position: s.position,
										paddingBefore: padding(s.paddingBefore),
										paddingAfter: padding(s.paddingAfter),
										aspectMode: optEnum(AspectMode, s.aspectMode, "AspectMode"),
									}),
							),
						}),
					),
				(r) => ({ id: r.id }),
			).then(id);
		},

		createStream: (encodingId, p) =>
			adoptOrCreateStamped({
				label: "stream",
				stamp: options.stamp,
				lookup: (expect) =>
					findStampedResource({
						label: "stream",
						expect,
						list: (q) => api.encoding.encodings.streams.list(encodingId, q),
						customData: (rid) =>
							api.encoding.encodings.streams.customdata.get(encodingId, rid),
					}),
				auditAdopt: stampAuditAdopt(
					`/encoding/encodings/${encodingId}/streams`,
				),
				create: () =>
					audited(
						"POST",
						`/encoding/encodings/${encodingId}/streams`,
						{ name: p.name, mode: p.mode, conditions: p.conditions },
						() =>
							api.encoding.encodings.streams.create(
								encodingId,
								new Stream({
									codecConfigId: p.codecConfigId,
									inputStreams: [
										// Live references the input directly (inputId + path +
										// position); VOD/file references a pre-built ingest stream.
										// SDK contract: position and selectionMode:AUTO are mutually
										// exclusive — keep bare position here, never re-add
										// selectionMode:AUTO alongside it (that reintroduces 2025).
										p.inputStreamId
											? new StreamInput({ inputStreamId: p.inputStreamId })
											: new StreamInput({
													inputId: p.inputId,
													inputPath: p.inputPath,
													position: p.position,
												}),
									],
									name: p.name,
									mode: sdkEnumValue(StreamMode, p.mode, "StreamMode"),
									conditions: conditions(p.conditions),
									// Plain object — the SDK model constructor maps it.
									...(p.perTitleSettings
										? {
												perTitleSettings:
													p.perTitleSettings as Stream["perTitleSettings"],
											}
										: {}),
								}),
							),
						(r) => ({ id: r.id }),
					).then(id),
			}),

		createDolbyVisionStreamHdr: (encodingId, streamId, p) =>
			audited(
				"POST",
				`/encoding/encodings/${encodingId}/streams/${streamId}/hdr/dolby-vision`,
				p,
				() =>
					api.encoding.encodings.streams.hdr.dolbyVision.create(
						encodingId,
						streamId,
						new DolbyVisionMetadata({
							profile: sdkEnumValue(
								DolbyVisionProfile,
								p.profile,
								"DolbyVisionProfile",
							),
							metadataSource: sdkEnumValue(
								DolbyVisionMetadataSource,
								p.metadataSource,
								"DolbyVisionMetadataSource",
							),
							metadataInputStreamId: p.metadataInputStreamId,
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createMediaFilter: (kind, p) => createMediaFilter(ctx, kind, p),
		createDeinterlaceFilter: (p) =>
			audited(
				"POST",
				"/encoding/filters/deinterlace",
				p,
				() =>
					api.encoding.filters.deinterlace.create(
						new DeinterlaceFilter({
							parity: sdkEnumValue(
								PictureFieldParity,
								p.parity,
								"PictureFieldParity",
							),
							mode: sdkEnumValue(DeinterlaceMode, p.mode, "DeinterlaceMode"),
							frameSelectionMode: sdkEnumValue(
								DeinterlaceFrameSelectionMode,
								p.frameSelectionMode,
								"DeinterlaceFrameSelectionMode",
							),
							autoEnable: sdkEnumValue(
								DeinterlaceAutoEnable,
								p.autoEnable,
								"DeinterlaceAutoEnable",
							),
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createBurnInSrt: (encodingId, streamId, p) =>
			audited(
				"POST",
				`/encoding/encodings/${encodingId}/streams/${streamId}/burn-in-subtitles/srt`,
				p,
				() =>
					api.encoding.encodings.streams.burnInSubtitles.srt.create(
						encodingId,
						streamId,
						new BurnInSubtitleSrt({
							// The live API requires name although SDK 1.280.0 marks it optional.
							name: "SRT subtitles",
							characterEncoding: sdkEnumValue(
								CaptionCharacterEncoding,
								p.characterEncoding,
								"CaptionCharacterEncoding",
							),
							input: new InputPath({
								inputId: p.inputId,
								inputPath: p.inputPath,
							}),
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),
		createStreamFilters: (encodingId, streamId, filters) =>
			audited(
				"POST",
				`/encoding/encodings/${encodingId}/streams/${streamId}/filters`,
				{ filters },
				() =>
					api.encoding.encodings.streams.filters.create(
						encodingId,
						streamId,
						filters.map(
							(f) => new StreamFilter({ id: f.id, position: f.position }),
						),
					),
				(r) => ({ attached: r.filters?.length ?? filters.length }),
			).then(() => undefined),

		createKeyframe: (encodingId, p) =>
			audited(
				"POST",
				`/encoding/encodings/${encodingId}/keyframes`,
				p,
				() =>
					api.encoding.encodings.keyframes.create(
						encodingId,
						new Keyframe({ time: p.time }),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createThumbnail: (encodingId, streamId, p) =>
			audited(
				"POST",
				`/encoding/encodings/${encodingId}/streams/${streamId}/thumbnails`,
				{
					height: p.height,
					pattern: p.pattern,
					unit: p.unit,
					positions: p.positions,
					outputPath: p.destination.outputPath,
				},
				() =>
					api.encoding.encodings.streams.thumbnails.create(
						encodingId,
						streamId,
						new Thumbnail({
							height: p.height,
							pattern: p.pattern,
							unit: sdkEnumValue(ThumbnailUnit, p.unit, "ThumbnailUnit"),
							positions: p.positions,
							outputs: outputs(p.destination),
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createSprite: (encodingId, streamId, p) =>
			audited(
				"POST",
				`/encoding/encodings/${encodingId}/streams/${streamId}/sprites`,
				{
					width: p.width,
					height: p.height,
					distance: p.distance,
					unit: p.unit,
					hTiles: p.hTiles,
					vTiles: p.vTiles,
					imagesPerFile: p.imagesPerFile,
					spriteName: p.spriteName,
					filename: p.filename,
					vttName: p.vttName,
					// C7: the local snapshot is the system of record after Bitmovin's
					// ~90-day purge, so record every field actually sent.
					creationMode: p.creationMode,
					name: p.name,
					outputPath: p.destination.outputPath,
				},
				() =>
					api.encoding.encodings.streams.sprites.create(
						encodingId,
						streamId,
						new Sprite({
							width: p.width,
							height: p.height,
							distance: p.distance,
							unit: sdkEnumValue(SpriteUnit, p.unit, "SpriteUnit"),
							hTiles: p.hTiles,
							vTiles: p.vTiles,
							imagesPerFile: p.imagesPerFile,
							spriteName: p.spriteName,
							filename: p.filename,
							vttName: p.vttName,
							creationMode: optEnum(
								SpriteCreationMode,
								p.creationMode,
								"SpriteCreationMode",
							),
							name: p.name,
							outputs: outputs(p.destination),
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createCmafMuxing: (encodingId, p) =>
			adoptOrCreateStamped({
				label: "cmaf muxing",
				stamp: options.stamp,
				lookup: (expect) =>
					findStampedResource({
						label: "cmaf muxing",
						expect,
						list: (q) => muxings().cmaf.list(encodingId, q),
						customData: (rid) => muxings().cmaf.customdata.get(encodingId, rid),
					}),
				auditAdopt: stampAuditAdopt(
					`/encoding/encodings/${encodingId}/muxings/cmaf`,
				),
				create: () =>
					audited(
						"POST",
						`/encoding/encodings/${encodingId}/muxings/cmaf`,
						{ name: p.name, outputPath: p.destination?.outputPath },
						() =>
							muxings().cmaf.create(
								encodingId,
								new CmafMuxing({
									segmentLength: p.segmentLength,
									segmentNaming: p.segmentNaming,
									segmentNamingTemplate: p.segmentNamingTemplate,
									initSegmentName: p.initSegmentName,
									initSegmentNameTemplate: p.initSegmentNameTemplate,
									framesPerCmafChunk: p.framesPerCmafChunk,
									streams: [new MuxingStream({ streamId: p.streamId })],
									outputs: outputs(p.destination),
									name: p.name,
								}),
							),
						(r) => ({ id: r.id }),
					).then(id),
			}),

		createFmp4Muxing: (encodingId, p) =>
			adoptOrCreateStamped({
				label: "fmp4 muxing",
				stamp: options.stamp,
				lookup: (expect) =>
					findStampedResource({
						label: "fmp4 muxing",
						expect,
						list: (q) => muxings().fmp4.list(encodingId, q),
						customData: (rid) => muxings().fmp4.customdata.get(encodingId, rid),
					}),
				auditAdopt: stampAuditAdopt(
					`/encoding/encodings/${encodingId}/muxings/fmp4`,
				),
				create: () =>
					audited(
						"POST",
						`/encoding/encodings/${encodingId}/muxings/fmp4`,
						{ name: p.name, outputPath: p.destination?.outputPath },
						() =>
							muxings().fmp4.create(
								encodingId,
								new Fmp4Muxing({
									segmentLength: p.segmentLength,
									segmentNaming: p.segmentNaming,
									segmentNamingTemplate: p.segmentNamingTemplate,
									initSegmentName: p.initSegmentName,
									streams: [new MuxingStream({ streamId: p.streamId })],
									outputs: outputs(p.destination),
									name: p.name,
									// undefined ⇒ omitted: SCTE-35 emsg only when ad markers on.
									signalScte35AsEmsg: p.signalScte35AsEmsg,
								}),
							),
						(r) => ({ id: r.id }),
					).then(id),
			}),

		createMp4Muxing: (encodingId, p) =>
			adoptOrCreateStamped({
				label: "mp4 muxing",
				stamp: options.stamp,
				lookup: (expect) =>
					findStampedResource({
						label: "mp4 muxing",
						expect,
						list: (q) => muxings().mp4.list(encodingId, q),
						customData: (rid) => muxings().mp4.customdata.get(encodingId, rid),
					}),
				auditAdopt: stampAuditAdopt(
					`/encoding/encodings/${encodingId}/muxings/mp4`,
				),
				create: () =>
					audited(
						"POST",
						`/encoding/encodings/${encodingId}/muxings/mp4`,
						{
							name: p.name,
							filename: p.filename,
							outputPath: p.destination?.outputPath,
						},
						() =>
							muxings().mp4.create(
								encodingId,
								new Mp4Muxing({
									filename: p.filename,
									fragmentDuration: p.fragmentDuration,
									fragmentedMP4MuxingManifestType: optEnum(
										FragmentedMp4MuxingManifestType,
										p.fragmentedMP4MuxingManifestType,
										"FragmentedMp4MuxingManifestType",
									),
									dolbyVisionConfiguration: p.dolbyVisionTrackSampleEntryName
										? new DolbyVisionMuxingConfiguration({
												trackSampleEntryName: sdkEnumValue(
													DolbyVisionTrackSampleEntryName,
													p.dolbyVisionTrackSampleEntryName,
													"DolbyVisionTrackSampleEntryName",
												),
											})
										: undefined,
									streams: muxingStreams(p),
									outputs: outputs(p.destination),
									name: p.name,
								}),
							),
						(r) => ({ id: r.id }),
					).then(id),
			}),

		createProgressiveWebmMuxing: (encodingId, p) =>
			adoptOrCreateStamped({
				label: "progressive webm muxing",
				stamp: options.stamp,
				lookup: (expect) =>
					findStampedResource({
						label: "progressive webm muxing",
						expect,
						list: (q) => muxings().progressiveWebm.list(encodingId, q),
						customData: (rid) =>
							muxings().progressiveWebm.customdata.get(encodingId, rid),
					}),
				auditAdopt: stampAuditAdopt(
					`/encoding/encodings/${encodingId}/muxings/progressive-webm`,
				),
				create: () =>
					audited(
						"POST",
						`/encoding/encodings/${encodingId}/muxings/progressive-webm`,
						{
							name: p.name,
							filename: p.filename,
							outputPath: p.destination?.outputPath,
						},
						() =>
							muxings().progressiveWebm.create(
								encodingId,
								new ProgressiveWebmMuxing({
									filename: p.filename,
									streams: [new MuxingStream({ streamId: p.streamId })],
									outputs: outputs(p.destination),
									name: p.name,
								}),
							),
						(r) => ({ id: r.id }),
					).then(id),
			}),

		createTsMuxing: (encodingId, p) =>
			adoptOrCreateStamped({
				label: "ts muxing",
				stamp: options.stamp,
				lookup: (expect) =>
					findStampedResource({
						label: "ts muxing",
						expect,
						list: (q) => muxings().ts.list(encodingId, q),
						customData: (rid) => muxings().ts.customdata.get(encodingId, rid),
					}),
				auditAdopt: stampAuditAdopt(
					`/encoding/encodings/${encodingId}/muxings/ts`,
				),
				create: () =>
					audited(
						"POST",
						`/encoding/encodings/${encodingId}/muxings/ts`,
						{ name: p.name, outputPath: p.destination?.outputPath },
						() =>
							muxings().ts.create(
								encodingId,
								new TsMuxing({
									segmentLength: p.segmentLength,
									segmentNaming: p.segmentNaming,
									segmentNamingTemplate: p.segmentNamingTemplate,
									streams: muxingStreams(p),
									outputs: outputs(p.destination),
									name: p.name,
								}),
							),
						(r) => ({ id: r.id }),
					).then(id),
			}),

		createWebmMuxing: (encodingId, p) =>
			adoptOrCreateStamped({
				label: "webm muxing",
				stamp: options.stamp,
				lookup: (expect) =>
					findStampedResource({
						label: "webm muxing",
						expect,
						list: (q) => muxings().webm.list(encodingId, q),
						customData: (rid) => muxings().webm.customdata.get(encodingId, rid),
					}),
				auditAdopt: stampAuditAdopt(
					`/encoding/encodings/${encodingId}/muxings/webm`,
				),
				create: () =>
					audited(
						"POST",
						`/encoding/encodings/${encodingId}/muxings/webm`,
						{ name: p.name, outputPath: p.destination?.outputPath },
						() =>
							muxings().webm.create(
								encodingId,
								new WebmMuxing({
									segmentLength: p.segmentLength,
									segmentNaming: p.segmentNaming,
									segmentNamingTemplate: p.segmentNamingTemplate,
									initSegmentName: p.initSegmentName,
									streams: [new MuxingStream({ streamId: p.streamId })],
									outputs: outputs(p.destination),
									name: p.name,
								}),
							),
						(r) => ({ id: r.id }),
					).then(id),
			}),

		createTextMuxing: (encodingId, p) =>
			adoptOrCreateStamped({
				label: "text muxing",
				stamp: options.stamp,
				lookup: (expect) =>
					findStampedResource({
						label: "text muxing",
						expect,
						list: (q) => muxings().text.list(encodingId, q),
						customData: (rid) => muxings().text.customdata.get(encodingId, rid),
					}),
				auditAdopt: stampAuditAdopt(
					`/encoding/encodings/${encodingId}/muxings/text`,
				),
				create: () =>
					audited(
						"POST",
						`/encoding/encodings/${encodingId}/muxings/text`,
						{ name: p.name, outputPath: p.destination?.outputPath },
						() =>
							muxings().text.create(
								encodingId,
								new TextMuxing({
									filename: p.filename,
									streams: [new MuxingStream({ streamId: p.streamId })],
									outputs: outputs(p.destination),
									name: p.name,
								}),
							),
						(r) => ({ id: r.id }),
					).then(id),
			}),
		createChunkedTextMuxing: (encodingId, p) =>
			adoptOrCreateStamped({
				label: "chunkedText muxing",
				stamp: options.stamp,
				lookup: (expect) =>
					findStampedResource({
						label: "chunkedText muxing",
						expect,
						list: (q) => muxings().chunkedText.list(encodingId, q),
						customData: (rid) =>
							muxings().chunkedText.customdata.get(encodingId, rid),
					}),
				auditAdopt: stampAuditAdopt(
					`/encoding/encodings/${encodingId}/muxings/chunked-text`,
				),
				create: () =>
					audited(
						"POST",
						`/encoding/encodings/${encodingId}/muxings/chunked-text`,
						{ name: p.name, outputPath: p.destination?.outputPath },
						() =>
							muxings().chunkedText.create(
								encodingId,
								new ChunkedTextMuxing({
									segmentLength: p.segmentLength,
									segmentNaming: p.segmentNaming,
									segmentNamingTemplate: p.segmentNamingTemplate,
									streams: [new MuxingStream({ streamId: p.streamId })],
									outputs: outputs(p.destination),
									name: p.name,
								}),
							),
						(r) => ({ id: r.id }),
					).then(id),
			}),

		listMuxings: async (encodingId, kind) => {
			const m = muxings();
			// C6: limit ≤ 100, always paginate to exhaustion.
			const limit = 100;
			const page = (offset: number) => {
				switch (kind) {
					case "CMAF":
						return m.cmaf.list(encodingId, { offset, limit });
					case "FMP4":
						return m.fmp4.list(encodingId, { offset, limit });
					case "TS":
						return m.ts.list(encodingId, { offset, limit });
					case "MP4":
						return m.mp4.list(encodingId, { offset, limit });
					case "WEBM":
						return m.webm.list(encodingId, { offset, limit });
					default: {
						const exhaustive: never = kind;
						throw new Error(`Unknown muxing kind ${String(exhaustive)}`);
					}
				}
			};
			const summaries: MuxingSummary[] = [];
			for (let offset = 0; ; offset += limit) {
				const response = await page(offset);
				const items = (response.items ?? []) as (Muxing & {
					filename?: string;
				})[];
				for (const muxing of items) {
					const streamId = muxing.streams?.[0]?.streamId;
					if (!muxing.id || !streamId) {
						throw new Error(
							`${kind} muxing list for encoding ${encodingId} returned an entry without id/stream`,
						);
					}
					// FIRST-OF-MANY GUARD (review of PR #147, the fourth instance of this
					// shape in the repo: `find`-one-DRM hid 8 of 16 writes, the either/or
					// union bug, the panel's muxings[0]). `outputs` is an ARRAY; reading
					// [0] here would silently drop sibling legs from the generated
					// manifest — segments missing, no error anywhere. The compiler emits
					// exactly one destination per muxing today, so >1 DISTINCT paths can
					// only mean that invariant broke (multi-destination support, or an
					// externally-shaped encoding); the day it does, this site must learn
					// to fan out, loudly — not pick a survivor.
					// Paths only: an output CARRYING no outputPath must not count as a
					// second "distinct path" — {a, undefined} is one base path plus one
					// pathless output, and calling that "2 distinct output paths" would
					// misdescribe it (review of PR #152).
					const muxingPaths = new Set(
						(muxing.outputs ?? [])
							.map((o) => o.outputPath)
							.filter((path): path is string => typeof path === "string"),
					);
					if (muxingPaths.size > 1) {
						throw new Error(
							`${kind} muxing ${muxing.id} of encoding ${encodingId} writes ${muxingPaths.size} distinct output paths — a manifest entry references ONE base path, and picking one would silently drop the other legs' segments`,
						);
					}
					summaries.push({
						id: muxing.id,
						streamId,
						outputPath: muxing.outputs?.[0]?.outputPath,
						avgBitrate: muxing.avgBitrate,
						filename: muxing.filename,
					});
				}
				if (items.length < limit) {
					return summaries;
				}
			}
		},

		getStreamContext: async (encodingId, streamId) => {
			const stream = await api.encoding.encodings.streams.get(
				encodingId,
				streamId,
			);
			if (!stream.mode || !stream.codecConfigId) {
				throw new Error(
					`stream ${streamId} of encoding ${encodingId} carries no mode/codecConfigId`,
				);
			}
			return {
				mode: String(stream.mode),
				codecConfigId: stream.codecConfigId,
			};
		},

		// The per-title capture's three reads are core's `bitmovinCapturePort`,
		// verbatim. They were written out here first and then a second time in the
		// backfill route — two chances for the C6 accounting or the `complete` flag
		// to drift apart, in a feature whose entire purpose is knowing whether you
		// saw the whole ladder. `api` satisfies core's structural
		// `EncodingApiSubset` by shape, so core still imports no SDK.
		listEncodingStreams: (encodingId) => capturePort.listStreams(encodingId),

		listAllMuxings: (encodingId) => capturePort.listMuxings(encodingId),

		listIngestInputStreams: async (encodingId) => {
			// C6: paginate. Read — not audited. The inputId each ingest stream
			// carries is a FROZEN copy taken when the stream was created.
			const limit = 100;
			const streams: { id: string; inputId?: string }[] = [];
			for (let offset = 0; ; offset += limit) {
				const response = await api.encoding.encodings.inputStreams.ingest.list(
					encodingId,
					{ offset, limit },
				);
				const items = response.items ?? [];
				for (const stream of items) {
					// SKIP a malformed entry rather than throw (unlike listRtmpInputs):
					// this is a best-effort diagnostic read, and a throw here would be
					// swallowed by the caller's try/catch, degrading the whole diagnosis.
					if (stream.id) {
						streams.push({ id: stream.id, inputId: stream.inputId });
					}
				}
				if (items.length < limit) {
					return streams;
				}
			}
		},
	};
}
