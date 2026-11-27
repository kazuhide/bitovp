export const encodingCodecProtocols = {
	"video-codecs": {
		av1: "AV1",
		h262: "H.262 (MPEG-2)",
		h264: "H.264 (AVC)",
		h265: "H.265 (HEVC)",
		h265v2: "H.265 v2 (HEVC)",
		mjpeg: "Motion JPEG",
		vp8: "VP8",
		vp9: "VP9",
	},
	"audio-codecs": {
		aac: "AAC",
		ac3: "AC-3",
		"dolby-atmos": "Dolby Atmos",
		"dolby-digital": "Dolby Digital",
		"dolby-digital-plus": "Dolby Digital Plus",
		dts: "DTS",
		"dts-passthrough": "DTS passthrough",
		dtsx: "DTS:X",
		eac3: "E-AC-3",
		"he-aac-v1": "HE-AAC v1",
		"he-aac-v2": "HE-AAC v2",
		mp2: "MP2",
		mp3: "MP3",
		opus: "Opus",
		passthrough: "Audio passthrough",
		pcm: "PCM",
		vorbis: "Vorbis",
	},
	"subtitle-codecs": {
		"dvb-subtitle": "DVB subtitles",
		imsc: "IMSC",
		webvtt: "WebVTT",
	},
} as const;

export type EncodingCodecCatalogueKind = keyof typeof encodingCodecProtocols;
