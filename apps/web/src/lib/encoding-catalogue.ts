import { encodingCodecProtocols } from "./encoding-codec-catalogue";
import { encodingFilterProtocols } from "./encoding-filter-catalogue";

export const encodingCatalogueKinds = [
	"templates",
	"watch-folders",
	"inputs",
	"outputs",
	"video-codecs",
	"audio-codecs",
	"subtitle-codecs",
	"filters",
] as const;
export type EncodingCatalogueKind = (typeof encodingCatalogueKinds)[number];

export const encodingIoProtocols = {
	inputs: {
		"akamai-netstorage": "Akamai NetStorage",
		aspera: "Aspera",
		azure: "Azure",
		"direct-file-upload": "Direct file upload",
		ftp: "FTP",
		gcs: "Google Cloud Storage",
		"gcs-service-account": "GCS service account",
		"generic-s3": "S3-compatible",
		hls: "HLS",
		http: "HTTP",
		https: "HTTPS",
		local: "Local",
		"redundant-rtmp": "Redundant RTMP",
		rtmp: "RTMP",
		s3: "Amazon S3",
		"s3-role-based": "Amazon S3 (IAM role)",
		sftp: "SFTP",
		srt: "SRT",
		zixi: "Zixi",
	},
	outputs: {
		"akamai-msl": "Akamai MSL",
		"akamai-netstorage": "Akamai NetStorage",
		azure: "Azure",
		cdn: "Bitmovin CDN",
		ftp: "FTP",
		gcs: "Google Cloud Storage",
		"gcs-service-account": "GCS service account",
		"generic-s3": "S3-compatible",
		"live-media-ingest": "Live Media Ingest",
		local: "Local",
		moq: "MoQ",
		s3: "Amazon S3",
		"s3-role-based": "Amazon S3 (IAM role)",
		sftp: "SFTP",
	},
} as const;

export const encodingCatalogueProtocols: Partial<
	Record<EncodingCatalogueKind, Readonly<Record<string, string>>>
> = {
	...encodingIoProtocols,
	...encodingCodecProtocols,
	filters: encodingFilterProtocols,
};
