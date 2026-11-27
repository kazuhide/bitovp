import "server-only";
import type {
	EncodingCatalogueKind,
	encodingIoProtocols,
} from "@/lib/encoding-catalogue";

import type { EncodingCatalogueReader as Reader } from "./encoding-catalogue-reader";

const allInputs: Reader = {
	list: (api, page) => api.encoding.inputs.list(page),
	get: (api, id) => api.encoding.inputs.get(id),
};

const allOutputs: Reader = {
	list: (api, page) => api.encoding.outputs.list(page),
	get: (api, id) => api.encoding.outputs.get(id),
	readType: (api, id) => api.encoding.outputs.type.get(id),
};

// Keep the actual SDK calls explicit so each protocol has a checkable transport.
const inputs = {
	"akamai-netstorage": {
		list: (api, page) => api.encoding.inputs.akamaiNetstorage.list(page),
		get: (api, id) => api.encoding.inputs.akamaiNetstorage.get(id),
		expectedType: "AKAMAI_NETSTORAGE",
		metadata: (api, id) =>
			api.encoding.inputs.akamaiNetstorage.customdata.get(id),
	},
	aspera: {
		list: (api, page) => api.encoding.inputs.aspera.list(page),
		get: (api, id) => api.encoding.inputs.aspera.get(id),
		expectedType: "ASPERA",
		metadata: (api, id) => api.encoding.inputs.aspera.customdata.get(id),
	},
	azure: {
		list: (api, page) => api.encoding.inputs.azure.list(page),
		get: (api, id) => api.encoding.inputs.azure.get(id),
		expectedType: "AZURE",
		metadata: (api, id) => api.encoding.inputs.azure.customdata.get(id),
	},
	"direct-file-upload": {
		list: (api, page) => api.encoding.inputs.directFileUpload.list(page),
		get: (api, id) => api.encoding.inputs.directFileUpload.get(id),
		expectedType: "DIRECT_FILE_UPLOAD",
		metadata: (api, id) =>
			api.encoding.inputs.directFileUpload.customdata.get(id),
	},
	ftp: {
		list: (api, page) => api.encoding.inputs.ftp.list(page),
		get: (api, id) => api.encoding.inputs.ftp.get(id),
		expectedType: "FTP",
		metadata: (api, id) => api.encoding.inputs.ftp.customdata.get(id),
	},
	gcs: {
		list: (api, page) => api.encoding.inputs.gcs.list(page),
		get: (api, id) => api.encoding.inputs.gcs.get(id),
		expectedType: "GCS",
		metadata: (api, id) => api.encoding.inputs.gcs.customdata.get(id),
	},
	"gcs-service-account": {
		list: (api, page) => api.encoding.inputs.gcsServiceAccount.list(page),
		get: (api, id) => api.encoding.inputs.gcsServiceAccount.get(id),
		expectedType: "GCS_SERVICE_ACCOUNT",
		metadata: (api, id) =>
			api.encoding.inputs.gcsServiceAccount.customdata.get(id),
	},
	"generic-s3": {
		list: (api, page) => api.encoding.inputs.genericS3.list(page),
		get: (api, id) => api.encoding.inputs.genericS3.get(id),
		expectedType: "GENERIC_S3",
		metadata: (api, id) => api.encoding.inputs.genericS3.customdata.get(id),
	},
	hls: {
		list: (api, page) => api.encoding.inputs.hls.list(page),
		get: (api, id) => api.encoding.inputs.hls.get(id),
	},
	http: {
		list: (api, page) => api.encoding.inputs.http.list(page),
		get: (api, id) => api.encoding.inputs.http.get(id),
		expectedType: "HTTP",
		metadata: (api, id) => api.encoding.inputs.http.customdata.get(id),
	},
	https: {
		list: (api, page) => api.encoding.inputs.https.list(page),
		get: (api, id) => api.encoding.inputs.https.get(id),
		expectedType: "HTTPS",
		metadata: (api, id) => api.encoding.inputs.https.customdata.get(id),
	},
	local: {
		list: (api, page) => api.encoding.inputs.local.list(page),
		get: (api, id) => api.encoding.inputs.local.get(id),
		expectedType: "LOCAL",
		metadata: (api, id) => api.encoding.inputs.local.customdata.get(id),
	},
	"redundant-rtmp": {
		list: (api, page) => api.encoding.inputs.redundantRtmp.list(page),
		get: (api, id) => api.encoding.inputs.redundantRtmp.get(id),
	},
	rtmp: {
		list: (api, page) => api.encoding.inputs.rtmp.list(page),
		get: (api, id) => api.encoding.inputs.rtmp.get(id),
	},
	s3: {
		list: (api, page) => api.encoding.inputs.s3.list(page),
		get: (api, id) => api.encoding.inputs.s3.get(id),
		expectedType: "S3",
		metadata: (api, id) => api.encoding.inputs.s3.customdata.get(id),
	},
	"s3-role-based": {
		list: (api, page) => api.encoding.inputs.s3RoleBased.list(page),
		get: (api, id) => api.encoding.inputs.s3RoleBased.get(id),
		expectedType: "S3_ROLE_BASED",
		metadata: (api, id) => api.encoding.inputs.s3RoleBased.customdata.get(id),
	},
	sftp: {
		list: (api, page) => api.encoding.inputs.sftp.list(page),
		get: (api, id) => api.encoding.inputs.sftp.get(id),
		expectedType: "SFTP",
		metadata: (api, id) => api.encoding.inputs.sftp.customdata.get(id),
	},
	srt: {
		list: (api, page) => api.encoding.inputs.srt.list(page),
		get: (api, id) => api.encoding.inputs.srt.get(id),
		expectedType: "SRT",
		metadata: (api, id) => api.encoding.inputs.srt.customdata.get(id),
	},
	zixi: {
		list: (api, page) => api.encoding.inputs.zixi.list(page),
		get: (api, id) => api.encoding.inputs.zixi.get(id),
		expectedType: "ZIXI",
		metadata: (api, id) => api.encoding.inputs.zixi.customdata.get(id),
	},
} satisfies Record<keyof typeof encodingIoProtocols.inputs, Reader>;

const outputs = {
	"akamai-msl": {
		list: (api, page) => api.encoding.outputs.akamaiMsl.list(page),
		get: (api, id) => api.encoding.outputs.akamaiMsl.get(id),
		expectedType: "AKAMAI_MSL",
		metadata: (api, id) => api.encoding.outputs.akamaiMsl.customdata.get(id),
	},
	"akamai-netstorage": {
		list: (api, page) => api.encoding.outputs.akamaiNetstorage.list(page),
		get: (api, id) => api.encoding.outputs.akamaiNetstorage.get(id),
		expectedType: "AKAMAI_NETSTORAGE",
		metadata: (api, id) =>
			api.encoding.outputs.akamaiNetstorage.customdata.get(id),
	},
	azure: {
		list: (api, page) => api.encoding.outputs.azure.list(page),
		get: (api, id) => api.encoding.outputs.azure.get(id),
		expectedType: "AZURE",
		metadata: (api, id) => api.encoding.outputs.azure.customdata.get(id),
	},
	cdn: {
		list: (api, page) => api.encoding.outputs.cdn.list(page),
		get: (api, id) => api.encoding.outputs.cdn.get(id),
	},
	ftp: {
		list: (api, page) => api.encoding.outputs.ftp.list(page),
		get: (api, id) => api.encoding.outputs.ftp.get(id),
		expectedType: "FTP",
		metadata: (api, id) => api.encoding.outputs.ftp.customdata.get(id),
	},
	gcs: {
		list: (api, page) => api.encoding.outputs.gcs.list(page),
		get: (api, id) => api.encoding.outputs.gcs.get(id),
		expectedType: "GCS",
		metadata: (api, id) => api.encoding.outputs.gcs.customdata.get(id),
	},
	"gcs-service-account": {
		list: (api, page) => api.encoding.outputs.gcsServiceAccount.list(page),
		get: (api, id) => api.encoding.outputs.gcsServiceAccount.get(id),
		expectedType: "GCS_SERVICE_ACCOUNT",
		metadata: (api, id) =>
			api.encoding.outputs.gcsServiceAccount.customdata.get(id),
	},
	"generic-s3": {
		list: (api, page) => api.encoding.outputs.genericS3.list(page),
		get: (api, id) => api.encoding.outputs.genericS3.get(id),
		expectedType: "GENERIC_S3",
		metadata: (api, id) => api.encoding.outputs.genericS3.customdata.get(id),
	},
	"live-media-ingest": {
		list: (api, page) => api.encoding.outputs.liveMediaIngest.list(page),
		get: (api, id) => api.encoding.outputs.liveMediaIngest.get(id),
		expectedType: "LIVE_MEDIA_INGEST",
		metadata: (api, id) =>
			api.encoding.outputs.liveMediaIngest.customdata.get(id),
	},
	local: {
		list: (api, page) => api.encoding.outputs.local.list(page),
		get: (api, id) => api.encoding.outputs.local.get(id),
		expectedType: "LOCAL",
		metadata: (api, id) => api.encoding.outputs.local.customdata.get(id),
	},
	moq: {
		list: (api, page) => api.encoding.outputs.moq.list(page),
		get: (api, id) => api.encoding.outputs.moq.get(id),
		expectedType: "MOQ",
		metadata: (api, id) => api.encoding.outputs.moq.customdata.get(id),
	},
	s3: {
		list: (api, page) => api.encoding.outputs.s3.list(page),
		get: (api, id) => api.encoding.outputs.s3.get(id),
		expectedType: "S3",
		metadata: (api, id) => api.encoding.outputs.s3.customdata.get(id),
	},
	"s3-role-based": {
		list: (api, page) => api.encoding.outputs.s3RoleBased.list(page),
		get: (api, id) => api.encoding.outputs.s3RoleBased.get(id),
		expectedType: "S3_ROLE_BASED",
		metadata: (api, id) => api.encoding.outputs.s3RoleBased.customdata.get(id),
	},
	sftp: {
		list: (api, page) => api.encoding.outputs.sftp.list(page),
		get: (api, id) => api.encoding.outputs.sftp.get(id),
		expectedType: "SFTP",
		metadata: (api, id) => api.encoding.outputs.sftp.customdata.get(id),
	},
} satisfies Record<keyof typeof encodingIoProtocols.outputs, Reader>;

export function encodingIoReader(
	kind: EncodingCatalogueKind,
	protocol?: string,
): Reader | undefined {
	if (kind !== "inputs" && kind !== "outputs") return;
	if (protocol === undefined) return kind === "inputs" ? allInputs : allOutputs;
	const catalogue: Readonly<Record<string, Reader>> =
		kind === "inputs" ? inputs : outputs;
	if (Object.hasOwn(catalogue, protocol)) return catalogue[protocol];
}
