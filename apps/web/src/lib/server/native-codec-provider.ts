import "server-only";
import { createHash } from "node:crypto";
import type BitmovinApi from "@bitmovin/api-sdk";
import {
	CodecConfigType,
	DtsAudioConfiguration,
	DtsMode,
	DtsPassthroughAudioConfiguration,
	DtsXAudioConfiguration,
	DtsXChannelLayout,
	DvbSubtitleConfiguration,
	H262VideoConfiguration,
	MjpegVideoConfiguration,
	Mp2AudioConfiguration,
	Mp3AudioConfiguration,
	OttLoudnessMode,
	ProfileH262,
	VorbisAudioConfiguration,
	Vp8VideoConfiguration,
} from "@bitmovin/api-sdk";
import { z } from "zod";
import {
	type CreateNativeCodec,
	type NativeCodecKind,
	nativeCodecUuid,
} from "../native-codec-configurations";
import { bitmovinClientFromBinding } from "./bitmovin";

type CodecEndpoint = {
	type: CodecConfigType;
	get: (api: BitmovinApi, id: string) => Promise<unknown>;
	list: (
		api: BitmovinApi,
		query: { name: string; limit: number; offset: number },
	) => Promise<unknown>;
	metadata: (api: BitmovinApi, id: string) => Promise<unknown>;
	remove: (api: BitmovinApi, id: string) => Promise<unknown>;
};

const endpoints: Record<NativeCodecKind, CodecEndpoint> = {
	dts: {
		type: CodecConfigType.DTS,
		get: (api, id) => api.encoding.configurations.audio.dts.get(id),
		list: (api, query) => api.encoding.configurations.audio.dts.list(query),
		metadata: (api, id) =>
			api.encoding.configurations.audio.dts.customdata.get(id),
		remove: (api, id) => api.encoding.configurations.audio.dts.delete(id),
	},
	"dts-passthrough": {
		type: CodecConfigType.DTS_PASSTHROUGH,
		get: (api, id) => api.encoding.configurations.audio.dtsPassthrough.get(id),
		list: (api, query) =>
			api.encoding.configurations.audio.dtsPassthrough.list(query),
		metadata: (api, id) =>
			api.encoding.configurations.audio.dtsPassthrough.customdata.get(id),
		remove: (api, id) =>
			api.encoding.configurations.audio.dtsPassthrough.delete(id),
	},
	dtsx: {
		type: CodecConfigType.DTSX,
		get: (api, id) => api.encoding.configurations.audio.dtsx.get(id),
		list: (api, query) => api.encoding.configurations.audio.dtsx.list(query),
		metadata: (api, id) =>
			api.encoding.configurations.audio.dtsx.customdata.get(id),
		remove: (api, id) => api.encoding.configurations.audio.dtsx.delete(id),
	},
	mp2: {
		type: CodecConfigType.MP2,
		get: (api, id) => api.encoding.configurations.audio.mp2.get(id),
		list: (api, query) => api.encoding.configurations.audio.mp2.list(query),
		metadata: (api, id) =>
			api.encoding.configurations.audio.mp2.customdata.get(id),
		remove: (api, id) => api.encoding.configurations.audio.mp2.delete(id),
	},
	mp3: {
		type: CodecConfigType.MP3,
		get: (api, id) => api.encoding.configurations.audio.mp3.get(id),
		list: (api, query) => api.encoding.configurations.audio.mp3.list(query),
		metadata: (api, id) =>
			api.encoding.configurations.audio.mp3.customdata.get(id),
		remove: (api, id) => api.encoding.configurations.audio.mp3.delete(id),
	},
	vorbis: {
		type: CodecConfigType.VORBIS,
		get: (api, id) => api.encoding.configurations.audio.vorbis.get(id),
		list: (api, query) => api.encoding.configurations.audio.vorbis.list(query),
		metadata: (api, id) =>
			api.encoding.configurations.audio.vorbis.customdata.get(id),
		remove: (api, id) => api.encoding.configurations.audio.vorbis.delete(id),
	},
	"dvb-subtitle": {
		type: CodecConfigType.DVB_SUBTITLE,
		get: (api, id) => api.encoding.configurations.subtitles.dvbSubtitle.get(id),
		list: (api, query) =>
			api.encoding.configurations.subtitles.dvbSubtitle.list(query),
		metadata: (api, id) =>
			api.encoding.configurations.subtitles.dvbSubtitle.customdata.get(id),
		remove: (api, id) =>
			api.encoding.configurations.subtitles.dvbSubtitle.delete(id),
	},
	h262: {
		type: CodecConfigType.H262,
		get: (api, id) => api.encoding.configurations.video.h262.get(id),
		list: (api, query) => api.encoding.configurations.video.h262.list(query),
		metadata: (api, id) =>
			api.encoding.configurations.video.h262.customdata.get(id),
		remove: (api, id) => api.encoding.configurations.video.h262.delete(id),
	},
	mjpeg: {
		type: CodecConfigType.MJPEG,
		get: (api, id) => api.encoding.configurations.video.mjpeg.get(id),
		list: (api, query) => api.encoding.configurations.video.mjpeg.list(query),
		metadata: (api, id) =>
			api.encoding.configurations.video.mjpeg.customdata.get(id),
		remove: (api, id) => api.encoding.configurations.video.mjpeg.delete(id),
	},
	vp8: {
		type: CodecConfigType.VP8,
		get: (api, id) => api.encoding.configurations.video.vp8.get(id),
		list: (api, query) => api.encoding.configurations.video.vp8.list(query),
		metadata: (api, id) =>
			api.encoding.configurations.video.vp8.customdata.get(id),
		remove: (api, id) => api.encoding.configurations.video.vp8.delete(id),
	},
};

function createCodec(
	api: BitmovinApi,
	body: CreateNativeCodec,
	common: { name: string; customData: Record<string, unknown> },
) {
	switch (body.codec) {
		case "dts":
			return api.encoding.configurations.audio.dts.create(
				new DtsAudioConfiguration({
					...common,
					bitrate: body.bitrate,
					rate: body.rate,
					mode: body.mode && DtsMode[body.mode],
				}),
			);
		case "dts-passthrough":
			return api.encoding.configurations.audio.dtsPassthrough.create(
				new DtsPassthroughAudioConfiguration({ ...common }),
			);
		case "dtsx":
			return api.encoding.configurations.audio.dtsx.create(
				new DtsXAudioConfiguration({
					...common,
					bitrate: body.bitrate,
					rate: 48000,
					channelLayout:
						body.channelLayout === "5.1.4"
							? DtsXChannelLayout.CL_5_1_4
							: DtsXChannelLayout.CL_5_1,
					ottLoudnessMode: OttLoudnessMode.DTSX_OTT_LOUDNESS_DETECT,
				}),
			);
		case "mp2":
			return api.encoding.configurations.audio.mp2.create(
				new Mp2AudioConfiguration({
					...common,
					bitrate: body.bitrate,
					rate: body.rate,
				}),
			);
		case "mp3":
			return api.encoding.configurations.audio.mp3.create(
				new Mp3AudioConfiguration({
					...common,
					bitrate: body.bitrate,
					rate: body.rate,
				}),
			);
		case "vorbis":
			return api.encoding.configurations.audio.vorbis.create(
				new VorbisAudioConfiguration({
					...common,
					bitrate: body.bitrate,
					rate: body.rate,
				}),
			);
		case "dvb-subtitle":
			return api.encoding.configurations.subtitles.dvbSubtitle.create(
				new DvbSubtitleConfiguration({ ...common }),
			);
		case "h262":
			return api.encoding.configurations.video.h262.create(
				new H262VideoConfiguration({
					...common,
					profile: ProfileH262[body.profile],
					bitrate: body.bitrate,
					width: body.width,
					height: body.height,
					rate: body.rate,
				}),
			);
		case "mjpeg":
			return api.encoding.configurations.video.mjpeg.create(
				new MjpegVideoConfiguration({
					...common,
					width: body.width,
					height: body.height,
					rate: body.rate,
					qScale: body.qScale,
				}),
			);
		case "vp8":
			return api.encoding.configurations.video.vp8.create(
				new Vp8VideoConfiguration({
					...common,
					bitrate: body.bitrate,
					width: body.width,
					height: body.height,
					rate: body.rate,
				}),
			);
	}
}

type Binding = { apiKey: string; tenantOrgId?: string | null };
type Owner = {
	id: string;
	codec: NativeCodecKind;
	name: string;
	ownerToken: string;
};
const envelope = z.object({
	status: z.literal("SUCCESS"),
	data: z.object({ result: z.unknown() }),
});
const codecResponse = z.object({
	id: nativeCodecUuid,
	type: z.string().optional(),
	name: z.string().optional(),
});
const codecPage = z.object({
	items: z.array(codecResponse).max(2),
	totalCount: z.int().nonnegative(),
	offset: z.literal(0).optional(),
});
const ownershipResponse = z.object({
	id: nativeCodecUuid.optional(),
	customData: z.object({
		bitovpNativeCodec: z.object({ ownerToken: nativeCodecUuid }),
	}),
});

class InvalidCodecResponse extends Error {}

function validateIdentity(
	resource: z.infer<typeof codecResponse>,
	endpoint: CodecEndpoint,
	expected?: string,
) {
	// Some typed responses omit the discriminator. If present, validate the raw
	// value before the SDK can substitute another model's type.
	if (
		(resource.type !== undefined && resource.type !== endpoint.type) ||
		(expected !== undefined && resource.id !== expected)
	)
		throw new InvalidCodecResponse();
}

async function request<T>(
	binding: Binding,
	signal: AbortSignal,
	action: (api: BitmovinApi) => Promise<unknown>,
	inspect: (result: unknown) => T,
): Promise<T> {
	let validated: { value: T } | undefined;
	await action(
		bitmovinClientFromBinding(binding, signal, async (_url, response) => {
			if (!response.ok) return;
			validated = {
				value: inspect(
					envelope.parse(await response.clone().json()).data.result,
				),
			};
		}),
	);
	if (!validated) throw new InvalidCodecResponse();
	return validated.value;
}

function providerName(owner: Owner) {
	const reference = createHash("sha256")
		.update(owner.ownerToken)
		.digest("hex")
		.slice(0, 24);
	return `${owner.name} (BitOVP ${reference})`;
}

export function createProviderCodec(
	binding: Binding,
	signal: AbortSignal,
	owner: Owner,
	body: CreateNativeCodec,
) {
	const endpoint = endpoints[owner.codec];
	const name = providerName(owner);
	return request(
		binding,
		signal,
		(api) =>
			createCodec(api, body, {
				name,
				customData: { bitovpNativeCodec: { ownerToken: owner.ownerToken } },
			}),
		(raw) => {
			const codec = codecResponse.parse(raw);
			validateIdentity(codec, endpoint);
			if (codec.name !== undefined && codec.name !== name)
				throw new InvalidCodecResponse();
			return codec.id;
		},
	);
}

export async function verifyProviderCodec(
	binding: Binding,
	signal: AbortSignal,
	owner: Owner,
	providerId: string,
) {
	const endpoint = endpoints[owner.codec];
	try {
		await request(
			binding,
			signal,
			(api) => endpoint.get(api, providerId),
			(raw) => {
				const codec = codecResponse.parse(raw);
				validateIdentity(codec, endpoint, providerId);
				if (codec.name !== providerName(owner))
					throw new InvalidCodecResponse();
			},
		);
	} catch (error) {
		if (providerCodecIsMissing(error)) return false;
		throw error;
	}
	await request(
		binding,
		signal,
		(api) => endpoint.metadata(api, providerId),
		(raw) => {
			const metadata = ownershipResponse.parse(raw);
			if (
				(metadata.id !== undefined && metadata.id !== providerId) ||
				metadata.customData.bitovpNativeCodec.ownerToken !== owner.ownerToken
			)
				throw new InvalidCodecResponse();
		},
	);
	return true;
}

export async function findProviderCodec(
	binding: Binding,
	signal: AbortSignal,
	owner: Owner,
) {
	const endpoint = endpoints[owner.codec];
	const name = providerName(owner);
	const providerId = await request(
		binding,
		signal,
		(api) => endpoint.list(api, { name, limit: 2, offset: 0 }),
		(raw) => {
			const page = codecPage.parse(raw);
			if (page.totalCount === 0 && page.items.length === 0) return null;
			const item = page.items[0];
			if (
				page.totalCount !== 1 ||
				page.items.length !== 1 ||
				item?.name !== name
			)
				throw new InvalidCodecResponse();
			validateIdentity(item, endpoint);
			return item.id;
		},
	);
	if (
		providerId &&
		!(await verifyProviderCodec(binding, signal, owner, providerId))
	)
		throw new InvalidCodecResponse();
	return providerId;
}

export function removeProviderCodec(
	binding: Binding,
	signal: AbortSignal,
	owner: Owner,
	providerId: string,
) {
	const endpoint = endpoints[owner.codec];
	return request(
		binding,
		signal,
		(api) => endpoint.remove(api, providerId),
		(raw) => validateIdentity(codecResponse.parse(raw), endpoint, providerId),
	);
}

export function providerCodecIsMissing(error: unknown) {
	const provider = error as {
		httpStatusCode?: number;
		errorCode?: number;
	} | null;
	return provider?.httpStatusCode === 404 && provider.errorCode === 1001;
}

export function providerCodecRefused(error: unknown) {
	const provider = error as {
		httpStatusCode?: number;
		errorCode?: number;
	} | null;
	return (
		typeof provider?.httpStatusCode === "number" &&
		typeof provider.errorCode === "number" &&
		provider.errorCode !== 0 &&
		[400, 401, 403, 409, 422].includes(provider.httpStatusCode)
	);
}
