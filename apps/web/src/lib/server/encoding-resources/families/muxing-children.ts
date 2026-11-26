import type { MuxingChildren } from "../muxing-children";

export const muxingChildren: MuxingChildren = {
	CREATE_MUXING_FMP4: {
		drm: {
			label: "DRM",
			wholeCollection: true,
			list: (api, encodingId, muxingId) =>
				api.encoding.encodings.muxings.fmp4.drm.list(encodingId, muxingId),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.fmp4.drm.get(encodingId, muxingId, id),
		},
		"drm.aes": {
			label: "AES",
			list: (api, encodingId, muxingId, page) =>
				api.encoding.encodings.muxings.fmp4.drm.aes.list(
					encodingId,
					muxingId,
					page,
				),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.fmp4.drm.aes.get(
					encodingId,
					muxingId,
					id,
				),
			metadata: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.fmp4.drm.aes.customdata.get(
					encodingId,
					muxingId,
					id,
				),
		},
		"drm.cenc": {
			label: "CENC",
			list: (api, encodingId, muxingId, page) =>
				api.encoding.encodings.muxings.fmp4.drm.cenc.list(
					encodingId,
					muxingId,
					page,
				),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.fmp4.drm.cenc.get(
					encodingId,
					muxingId,
					id,
				),
			metadata: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.fmp4.drm.cenc.customdata.get(
					encodingId,
					muxingId,
					id,
				),
		},
		"drm.clearkey": {
			label: "ClearKey",
			list: (api, encodingId, muxingId, page) =>
				api.encoding.encodings.muxings.fmp4.drm.clearkey.list(
					encodingId,
					muxingId,
					page,
				),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.fmp4.drm.clearkey.get(
					encodingId,
					muxingId,
					id,
				),
			metadata: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.fmp4.drm.clearkey.customdata.get(
					encodingId,
					muxingId,
					id,
				),
		},
		"drm.fairplay": {
			label: "FairPlay",
			list: (api, encodingId, muxingId, page) =>
				api.encoding.encodings.muxings.fmp4.drm.fairplay.list(
					encodingId,
					muxingId,
					page,
				),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.fmp4.drm.fairplay.get(
					encodingId,
					muxingId,
					id,
				),
			metadata: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.fmp4.drm.fairplay.customdata.get(
					encodingId,
					muxingId,
					id,
				),
		},
		"drm.marlin": {
			label: "Marlin",
			list: (api, encodingId, muxingId, page) =>
				api.encoding.encodings.muxings.fmp4.drm.marlin.list(
					encodingId,
					muxingId,
					page,
				),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.fmp4.drm.marlin.get(
					encodingId,
					muxingId,
					id,
				),
			metadata: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.fmp4.drm.marlin.customdata.get(
					encodingId,
					muxingId,
					id,
				),
		},
		"drm.playready": {
			label: "PlayReady",
			list: (api, encodingId, muxingId, page) =>
				api.encoding.encodings.muxings.fmp4.drm.playready.list(
					encodingId,
					muxingId,
					page,
				),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.fmp4.drm.playready.get(
					encodingId,
					muxingId,
					id,
				),
			metadata: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.fmp4.drm.playready.customdata.get(
					encodingId,
					muxingId,
					id,
				),
		},
		"drm.primetime": {
			label: "Adobe Primetime",
			list: (api, encodingId, muxingId, page) =>
				api.encoding.encodings.muxings.fmp4.drm.primetime.list(
					encodingId,
					muxingId,
					page,
				),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.fmp4.drm.primetime.get(
					encodingId,
					muxingId,
					id,
				),
			metadata: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.fmp4.drm.primetime.customdata.get(
					encodingId,
					muxingId,
					id,
				),
		},
		"drm.speke": {
			label: "SPEKE",
			list: (api, encodingId, muxingId, page) =>
				api.encoding.encodings.muxings.fmp4.drm.speke.list(
					encodingId,
					muxingId,
					page,
				),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.fmp4.drm.speke.get(
					encodingId,
					muxingId,
					id,
				),
			metadata: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.fmp4.drm.speke.customdata.get(
					encodingId,
					muxingId,
					id,
				),
		},
		"drm.widevine": {
			label: "Widevine",
			list: (api, encodingId, muxingId, page) =>
				api.encoding.encodings.muxings.fmp4.drm.widevine.list(
					encodingId,
					muxingId,
					page,
				),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.fmp4.drm.widevine.get(
					encodingId,
					muxingId,
					id,
				),
			metadata: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.fmp4.drm.widevine.customdata.get(
					encodingId,
					muxingId,
					id,
				),
		},
	},
	CREATE_MUXING_MP4: {
		drm: {
			label: "DRM",
			wholeCollection: true,
			list: (api, encodingId, muxingId) =>
				api.encoding.encodings.muxings.mp4.drm.list(encodingId, muxingId),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.mp4.drm.get(encodingId, muxingId, id),
		},
		"drm.cenc": {
			label: "CENC",
			list: (api, encodingId, muxingId, page) =>
				api.encoding.encodings.muxings.mp4.drm.cenc.list(
					encodingId,
					muxingId,
					page,
				),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.mp4.drm.cenc.get(
					encodingId,
					muxingId,
					id,
				),
			metadata: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.mp4.drm.cenc.customdata.get(
					encodingId,
					muxingId,
					id,
				),
		},
		"drm.clearkey": {
			label: "ClearKey",
			list: (api, encodingId, muxingId, page) =>
				api.encoding.encodings.muxings.mp4.drm.clearkey.list(
					encodingId,
					muxingId,
					page,
				),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.mp4.drm.clearkey.get(
					encodingId,
					muxingId,
					id,
				),
			metadata: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.mp4.drm.clearkey.customdata.get(
					encodingId,
					muxingId,
					id,
				),
		},
		"drm.marlin": {
			label: "Marlin",
			list: (api, encodingId, muxingId, page) =>
				api.encoding.encodings.muxings.mp4.drm.marlin.list(
					encodingId,
					muxingId,
					page,
				),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.mp4.drm.marlin.get(
					encodingId,
					muxingId,
					id,
				),
			metadata: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.mp4.drm.marlin.customdata.get(
					encodingId,
					muxingId,
					id,
				),
		},
		"drm.playready": {
			label: "PlayReady",
			list: (api, encodingId, muxingId, page) =>
				api.encoding.encodings.muxings.mp4.drm.playready.list(
					encodingId,
					muxingId,
					page,
				),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.mp4.drm.playready.get(
					encodingId,
					muxingId,
					id,
				),
			metadata: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.mp4.drm.playready.customdata.get(
					encodingId,
					muxingId,
					id,
				),
		},
		"drm.speke": {
			label: "SPEKE",
			list: (api, encodingId, muxingId, page) =>
				api.encoding.encodings.muxings.mp4.drm.speke.list(
					encodingId,
					muxingId,
					page,
				),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.mp4.drm.speke.get(
					encodingId,
					muxingId,
					id,
				),
			metadata: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.mp4.drm.speke.customdata.get(
					encodingId,
					muxingId,
					id,
				),
		},
		"drm.widevine": {
			label: "Widevine",
			list: (api, encodingId, muxingId, page) =>
				api.encoding.encodings.muxings.mp4.drm.widevine.list(
					encodingId,
					muxingId,
					page,
				),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.mp4.drm.widevine.get(
					encodingId,
					muxingId,
					id,
				),
			metadata: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.mp4.drm.widevine.customdata.get(
					encodingId,
					muxingId,
					id,
				),
		},
	},
	CREATE_MUXING_PROGRESSIVE_TS: {
		drm: {
			label: "DRM",
			wholeCollection: true,
			list: (api, encodingId, muxingId) =>
				api.encoding.encodings.muxings.progressiveTs.drm.list(
					encodingId,
					muxingId,
				),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.progressiveTs.drm.get(
					encodingId,
					muxingId,
					id,
				),
		},
		"drm.aes": {
			label: "AES",
			list: (api, encodingId, muxingId, page) =>
				api.encoding.encodings.muxings.progressiveTs.drm.aes.list(
					encodingId,
					muxingId,
					page,
				),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.progressiveTs.drm.aes.get(
					encodingId,
					muxingId,
					id,
				),
			metadata: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.progressiveTs.drm.aes.customdata.get(
					encodingId,
					muxingId,
					id,
				),
		},
		"drm.fairplay": {
			label: "FairPlay",
			list: (api, encodingId, muxingId, page) =>
				api.encoding.encodings.muxings.progressiveTs.drm.fairplay.list(
					encodingId,
					muxingId,
					page,
				),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.progressiveTs.drm.fairplay.get(
					encodingId,
					muxingId,
					id,
				),
			metadata: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.progressiveTs.drm.fairplay.customdata.get(
					encodingId,
					muxingId,
					id,
				),
		},
		"drm.speke": {
			label: "SPEKE",
			list: (api, encodingId, muxingId, page) =>
				api.encoding.encodings.muxings.progressiveTs.drm.speke.list(
					encodingId,
					muxingId,
					page,
				),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.progressiveTs.drm.speke.get(
					encodingId,
					muxingId,
					id,
				),
			metadata: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.progressiveTs.drm.speke.customdata.get(
					encodingId,
					muxingId,
					id,
				),
		},
		id3: {
			label: "ID3",
			list: (api, encodingId, muxingId, page) =>
				api.encoding.encodings.muxings.progressiveTs.id3.list(
					encodingId,
					muxingId,
					page,
				),
		},
		"id3.frameId": {
			label: "ID3 · Frame ID",
			list: (api, encodingId, muxingId, page) =>
				api.encoding.encodings.muxings.progressiveTs.id3.frameId.list(
					encodingId,
					muxingId,
					page,
				),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.progressiveTs.id3.frameId.get(
					encodingId,
					muxingId,
					id,
				),
			metadata: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.progressiveTs.id3.frameId.customdata.get(
					encodingId,
					muxingId,
					id,
				),
		},
		"id3.plainText": {
			label: "ID3 · Plain text",
			list: (api, encodingId, muxingId, page) =>
				api.encoding.encodings.muxings.progressiveTs.id3.plainText.list(
					encodingId,
					muxingId,
					page,
				),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.progressiveTs.id3.plainText.get(
					encodingId,
					muxingId,
					id,
				),
			metadata: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.progressiveTs.id3.plainText.customdata.get(
					encodingId,
					muxingId,
					id,
				),
		},
		"id3.raw": {
			label: "ID3 · Raw",
			list: (api, encodingId, muxingId, page) =>
				api.encoding.encodings.muxings.progressiveTs.id3.raw.list(
					encodingId,
					muxingId,
					page,
				),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.progressiveTs.id3.raw.get(
					encodingId,
					muxingId,
					id,
				),
			metadata: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.progressiveTs.id3.raw.customdata.get(
					encodingId,
					muxingId,
					id,
				),
		},
	},
	CREATE_MUXING_PROGRESSIVE_WEBM: {
		drm: {
			label: "DRM",
			wholeCollection: true,
			list: (api, encodingId, muxingId) =>
				api.encoding.encodings.muxings.progressiveWebm.drm.list(
					encodingId,
					muxingId,
				),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.progressiveWebm.drm.get(
					encodingId,
					muxingId,
					id,
				),
		},
		"drm.cenc": {
			label: "CENC",
			list: (api, encodingId, muxingId, page) =>
				api.encoding.encodings.muxings.progressiveWebm.drm.cenc.list(
					encodingId,
					muxingId,
					page,
				),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.progressiveWebm.drm.cenc.get(
					encodingId,
					muxingId,
					id,
				),
			metadata: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.progressiveWebm.drm.cenc.customdata.get(
					encodingId,
					muxingId,
					id,
				),
		},
		"drm.speke": {
			label: "SPEKE",
			list: (api, encodingId, muxingId, page) =>
				api.encoding.encodings.muxings.progressiveWebm.drm.speke.list(
					encodingId,
					muxingId,
					page,
				),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.progressiveWebm.drm.speke.get(
					encodingId,
					muxingId,
					id,
				),
			metadata: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.progressiveWebm.drm.speke.customdata.get(
					encodingId,
					muxingId,
					id,
				),
		},
	},
	CREATE_MUXING_TS: {
		drm: {
			label: "DRM",
			wholeCollection: true,
			list: (api, encodingId, muxingId) =>
				api.encoding.encodings.muxings.ts.drm.list(encodingId, muxingId),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.ts.drm.get(encodingId, muxingId, id),
		},
		"drm.aes": {
			label: "AES",
			list: (api, encodingId, muxingId, page) =>
				api.encoding.encodings.muxings.ts.drm.aes.list(
					encodingId,
					muxingId,
					page,
				),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.ts.drm.aes.get(encodingId, muxingId, id),
			metadata: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.ts.drm.aes.customdata.get(
					encodingId,
					muxingId,
					id,
				),
		},
		"drm.fairplay": {
			label: "FairPlay",
			list: (api, encodingId, muxingId, page) =>
				api.encoding.encodings.muxings.ts.drm.fairplay.list(
					encodingId,
					muxingId,
					page,
				),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.ts.drm.fairplay.get(
					encodingId,
					muxingId,
					id,
				),
			metadata: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.ts.drm.fairplay.customdata.get(
					encodingId,
					muxingId,
					id,
				),
		},
		"drm.speke": {
			label: "SPEKE",
			list: (api, encodingId, muxingId, page) =>
				api.encoding.encodings.muxings.ts.drm.speke.list(
					encodingId,
					muxingId,
					page,
				),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.ts.drm.speke.get(
					encodingId,
					muxingId,
					id,
				),
			metadata: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.ts.drm.speke.customdata.get(
					encodingId,
					muxingId,
					id,
				),
		},
	},
	CREATE_MUXING_WEBM: {
		drm: {
			label: "DRM",
			wholeCollection: true,
			list: (api, encodingId, muxingId) =>
				api.encoding.encodings.muxings.webm.drm.list(encodingId, muxingId),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.webm.drm.get(encodingId, muxingId, id),
		},
		"drm.cenc": {
			label: "CENC",
			list: (api, encodingId, muxingId, page) =>
				api.encoding.encodings.muxings.webm.drm.cenc.list(
					encodingId,
					muxingId,
					page,
				),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.webm.drm.cenc.get(
					encodingId,
					muxingId,
					id,
				),
			metadata: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.webm.drm.cenc.customdata.get(
					encodingId,
					muxingId,
					id,
				),
		},
		"drm.speke": {
			label: "SPEKE",
			list: (api, encodingId, muxingId, page) =>
				api.encoding.encodings.muxings.webm.drm.speke.list(
					encodingId,
					muxingId,
					page,
				),
			get: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.webm.drm.speke.get(
					encodingId,
					muxingId,
					id,
				),
			metadata: (api, encodingId, muxingId, id) =>
				api.encoding.encodings.muxings.webm.drm.speke.customdata.get(
					encodingId,
					muxingId,
					id,
				),
		},
	},
};
