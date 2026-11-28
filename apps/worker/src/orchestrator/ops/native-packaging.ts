import {
	AesEncryptionDrm,
	AesEncryptionMethod,
	BroadcastTsMuxing,
	ClearKeyDrm,
	FrameIdId3Tag,
	H262VideoConfiguration,
	Id3TagPositionMode,
	MarlinDrm,
	Mp3AudioConfiguration,
	Mp3Muxing,
	MuxingStream,
	MxfMuxing,
	PackedAudioMuxing,
	PlaintextId3Tag,
	PlayReadyDrm,
	PlayReadyEncryptionMethod,
	PrimeTimeDrm,
	ProfileH262,
	RawId3Tag,
	SegmentedRawMuxing,
	WidevineDrm,
} from "@bitmovin/api-sdk";
import { aesKeyFileUriSchema } from "@bitovp/core";
import { withProviderCreateRefusal } from "../provider-create-refusal";
import type { Destination } from "../sdk-ops";
import type { OpsContext } from "./context";
import {
	adoptOrCreateStamped,
	findStampedResource,
	optEnum,
	outputs,
	type StampPageQuery,
	sdkEnumValue,
} from "./shared";

type MuxingParameters = {
	kind: string;
	streamId: string;
	additionalStreamIds?: string[];
	destination?: Destination;
	name?: string;
	filename?: string;
	segmentLength?: number;
	segmentNaming?: string;
};
type DrmParameters = {
	muxingKind: string;
	kind: string;
	destination?: Destination;
	name?: string;
	key: string;
	kid?: string;
	pssh?: string;
	iv?: string;
	keyFileUri?: string;
	method?: string;
};
type Id3Parameters = {
	format: string;
	positionMode: string;
	frame?: number;
	time?: number;
	frameId?: string;
	bytes?: string;
	text?: string;
};
type CodecParameters = {
	kind: "MP3" | "H262";
	name?: string;
	bitrate: number;
	rate?: number;
	width?: number;
	height?: number;
	profile?: string;
};

type Resource = { id?: string };
type ListResult = { items?: Resource[]; totalCount?: number };
type Metadata = { customData?: unknown };
type Endpoint = {
	list(encodingId: string, page: StampPageQuery): Promise<ListResult>;
	customdata: { get(encodingId: string, id: string): Promise<Metadata> };
};
type ChildEndpoint = {
	list(
		encodingId: string,
		muxingId: string,
		page: StampPageQuery,
	): Promise<ListResult>;
	customdata: {
		get(encodingId: string, muxingId: string, id: string): Promise<Metadata>;
	};
};

export type NativePackagingOps = {
	createNativeDeliveryCodec(parameters: CodecParameters): Promise<string>;
	createNativeMuxing(
		encodingId: string,
		parameters: MuxingParameters,
	): Promise<string>;
	createTypedMuxingDrm(
		encodingId: string,
		muxingId: string,
		parameters: DrmParameters,
	): Promise<string>;
	createProgressiveTsId3(
		encodingId: string,
		muxingId: string,
		parameters: Id3Parameters,
	): Promise<string>;
};

export function createNativePackagingOps(ctx: OpsContext): NativePackagingOps {
	const { api, audited, id, options, stampAuditAdopt } = ctx;
	const write = (
		path: string,
		request: object,
		list: (page: StampPageQuery) => Promise<ListResult>,
		customData: (resource: string) => Promise<Metadata>,
		create: () => Promise<Resource>,
		reconcileOnlyOnRetry = false,
	) => {
		const stamp = options.stamp;
		const label = reconcileOnlyOnRetry
			? "Progressive TS ID3 tag"
			: "delivery resource";
		return adoptOrCreateStamped({
			label,
			stamp:
				stamp && reconcileOnlyOnRetry
					? {
							...stamp,
							allowCreate: () =>
								stamp.allowCreate?.() !== false &&
								stamp.adoptWindow?.() !== true,
						}
					: stamp,
			lookup: (expect) =>
				findStampedResource({
					label,
					expect,
					requireUniqueMatch: reconcileOnlyOnRetry,
					list,
					customData,
				}),
			auditAdopt: stampAuditAdopt(path),
			create: () =>
				audited("POST", path, request, create, (row) => ({ id: row.id })).then(
					id,
				),
		});
	};

	return {
		createNativeDeliveryCodec(parameters) {
			const common = {
				name: parameters.name,
				bitrate: parameters.bitrate,
				rate: parameters.rate,
			};
			if (parameters.kind === "MP3")
				return write(
					"/encoding/configurations/audio/mp3",
					common,
					(page) => api.encoding.configurations.audio.mp3.list(page),
					(resource) =>
						api.encoding.configurations.audio.mp3.customdata.get(resource),
					() =>
						api.encoding.configurations.audio.mp3.create(
							new Mp3AudioConfiguration(common),
						),
				);
			return write(
				"/encoding/configurations/video/h262",
				common,
				(page) => api.encoding.configurations.video.h262.list(page),
				(resource) =>
					api.encoding.configurations.video.h262.customdata.get(resource),
				() =>
					api.encoding.configurations.video.h262.create(
						new H262VideoConfiguration({
							...common,
							width: parameters.width,
							height: parameters.height,
							profile: sdkEnumValue(
								ProfileH262,
								parameters.profile ?? "",
								"ProfileH262",
							),
						}),
					),
			);
		},
		createNativeMuxing(encodingId, parameters) {
			const m = api.encoding.encodings.muxings;
			const common = {
				name: parameters.name,
				outputs: outputs(parameters.destination),
				streams: [
					parameters.streamId,
					...(parameters.additionalStreamIds ?? []),
				].map((streamId) => new MuxingStream({ streamId })),
			};
			const file = { ...common, filename: parameters.filename };
			const segments = {
				...common,
				segmentLength: parameters.segmentLength,
				segmentNaming: parameters.segmentNaming,
			};
			const send = (
				suffix: string,
				endpoint: Endpoint,
				create: () => Promise<Resource>,
			) =>
				write(
					`/encoding/encodings/${encodingId}/muxings/${suffix}`,
					{
						kind: parameters.kind,
						outputPath: parameters.destination?.outputPath,
					},
					(page) => endpoint.list(encodingId, page),
					(resource) => endpoint.customdata.get(encodingId, resource),
					create,
				);
			switch (parameters.kind) {
				case "BROADCAST_TS":
					return send("broadcast-ts", m.broadcastTs, () =>
						m.broadcastTs.create(encodingId, new BroadcastTsMuxing(file)),
					);
				case "MP3":
					return send("mp3", m.mp3, () =>
						m.mp3.create(encodingId, new Mp3Muxing(file)),
					);
				case "MXF":
					return send("mxf", m.mxf, () =>
						m.mxf.create(encodingId, new MxfMuxing(file)),
					);
				case "PACKED_AUDIO":
					return send("packed-audio", m.packedAudio, () =>
						m.packedAudio.create(encodingId, new PackedAudioMuxing(segments)),
					);
				case "SEGMENTED_RAW":
					return send("segmented-raw", m.segmentedRaw, () =>
						m.segmentedRaw.create(encodingId, new SegmentedRawMuxing(segments)),
					);
				default:
					throw new Error("Unsupported delivery muxing");
			}
		},
		createTypedMuxingDrm(encodingId, muxingId, p) {
			const m = api.encoding.encodings.muxings;
			const common = {
				key: p.key,
				name: p.name,
				outputs: outputs(p.destination),
			};
			const send = (
				muxing: string,
				endpoint: ChildEndpoint,
				create: () => Promise<Resource>,
			) =>
				write(
					`/encoding/encodings/${encodingId}/muxings/${muxing}/${muxingId}/drm/${p.kind.toLowerCase()}`,
					{ drmKind: p.kind, muxingKind: p.muxingKind },
					(page) => endpoint.list(encodingId, muxingId, page),
					(resource) => endpoint.customdata.get(encodingId, muxingId, resource),
					create,
				);
			switch (p.kind) {
				case "AES": {
					const model = new AesEncryptionDrm({
						...common,
						iv: p.iv,
						keyFileUri: aesKeyFileUriSchema.parse(p.keyFileUri),
						method: sdkEnumValue(
							AesEncryptionMethod,
							p.method ?? "",
							"AesEncryptionMethod",
						),
					});
					if (p.muxingKind === "FMP4")
						return send("fmp4", m.fmp4.drm.aes, () =>
							m.fmp4.drm.aes.create(encodingId, muxingId, model),
						);
					if (p.muxingKind === "TS")
						return send("ts", m.ts.drm.aes, () =>
							m.ts.drm.aes.create(encodingId, muxingId, model),
						);
					if (p.muxingKind === "PROGRESSIVE_TS")
						return send("progressive-ts", m.progressiveTs.drm.aes, () =>
							m.progressiveTs.drm.aes.create(encodingId, muxingId, model),
						);
					if (p.muxingKind === "PACKED_AUDIO")
						return send("packed-audio", m.packedAudio.drm.aes, () =>
							m.packedAudio.drm.aes.create(encodingId, muxingId, model),
						);
					break;
				}
				case "CLEARKEY": {
					const model = new ClearKeyDrm({ ...common, kid: p.kid });
					if (p.muxingKind === "FMP4")
						return send("fmp4", m.fmp4.drm.clearkey, () =>
							m.fmp4.drm.clearkey.create(encodingId, muxingId, model),
						);
					if (p.muxingKind === "MP4")
						return send("mp4", m.mp4.drm.clearkey, () =>
							m.mp4.drm.clearkey.create(encodingId, muxingId, model),
						);
					break;
				}
				case "MARLIN": {
					const model = new MarlinDrm({ ...common, kid: p.kid });
					if (p.muxingKind === "FMP4")
						return send("fmp4", m.fmp4.drm.marlin, () =>
							m.fmp4.drm.marlin.create(encodingId, muxingId, model),
						);
					if (p.muxingKind === "MP4")
						return send("mp4", m.mp4.drm.marlin, () =>
							m.mp4.drm.marlin.create(encodingId, muxingId, model),
						);
					break;
				}
				case "PLAYREADY": {
					const model = new PlayReadyDrm({
						...common,
						kid: p.kid,
						pssh: p.pssh,
						method: optEnum(
							PlayReadyEncryptionMethod,
							p.method,
							"PlayReadyEncryptionMethod",
						),
					});
					if (p.muxingKind === "FMP4")
						return send("fmp4", m.fmp4.drm.playready, () =>
							m.fmp4.drm.playready.create(encodingId, muxingId, model),
						);
					if (p.muxingKind === "MP4")
						return send("mp4", m.mp4.drm.playready, () =>
							m.mp4.drm.playready.create(encodingId, muxingId, model),
						);
					break;
				}
				case "PRIMETIME": {
					const model = new PrimeTimeDrm({
						...common,
						kid: p.kid,
						pssh: p.pssh,
					});
					if (p.muxingKind === "FMP4")
						return send("fmp4", m.fmp4.drm.primetime, () =>
							m.fmp4.drm.primetime.create(encodingId, muxingId, model),
						);
					break;
				}
				case "WIDEVINE": {
					const model = new WidevineDrm({
						...common,
						kid: p.kid,
						pssh: p.pssh,
					});
					if (p.muxingKind === "FMP4")
						return send("fmp4", m.fmp4.drm.widevine, () =>
							m.fmp4.drm.widevine.create(encodingId, muxingId, model),
						);
					if (p.muxingKind === "MP4")
						return send("mp4", m.mp4.drm.widevine, () =>
							m.mp4.drm.widevine.create(encodingId, muxingId, model),
						);
					break;
				}
			}
			throw new Error("Unsupported DRM and muxing combination");
		},
		createProgressiveTsId3(encodingId, muxingId, p) {
			const m = api.encoding.encodings.muxings;
			const common = {
				positionMode: sdkEnumValue(
					Id3TagPositionMode,
					p.positionMode,
					"Id3TagPositionMode",
				),
				frame: p.frame,
				time: p.time,
			};
			const send = (
				suffix: string,
				endpoint: ChildEndpoint,
				create: () => Promise<Resource>,
			) =>
				write(
					`/encoding/encodings/${encodingId}/muxings/progressive-ts/${muxingId}/id3/${suffix}`,
					{ format: p.format, ...common },
					(page) => endpoint.list(encodingId, muxingId, page),
					(resource) => endpoint.customdata.get(encodingId, muxingId, resource),
					() => withProviderCreateRefusal(create),
					true,
				);
			switch (p.format) {
				case "FRAME_ID":
					return send("frame-id", m.progressiveTs.id3.frameId, () =>
						m.progressiveTs.id3.frameId.create(
							encodingId,
							muxingId,
							new FrameIdId3Tag({
								...common,
								bytes: p.bytes,
								frameId: p.frameId,
							}),
						),
					);
				case "PLAIN_TEXT":
					return send("plain-text", m.progressiveTs.id3.plainText, () =>
						m.progressiveTs.id3.plainText.create(
							encodingId,
							muxingId,
							new PlaintextId3Tag({
								...common,
								text: p.text,
								frameId: p.frameId,
							}),
						),
					);
				case "RAW":
					return send("raw", m.progressiveTs.id3.raw, () =>
						m.progressiveTs.id3.raw.create(
							encodingId,
							muxingId,
							new RawId3Tag({ ...common, bytes: p.bytes }),
						),
					);
				default:
					throw new Error("Unsupported ID3 tag format");
			}
		},
	};
}
