import "server-only";
import type BitmovinApi from "@bitmovin/api-sdk";
import type {
	EncodingCatalogueKind,
	encodingIoProtocols,
} from "@/lib/encoding-catalogue";

type Reader = {
	list: (
		api: BitmovinApi,
		page: { offset: number; limit: number },
	) => Promise<unknown>;
	get: (api: BitmovinApi, id: string) => Promise<unknown>;
};

// Keep the actual SDK calls explicit so each protocol has a checkable transport.
const inputs = {
	"akamai-netstorage": {
		list: (api, page) => api.encoding.inputs.akamaiNetstorage.list(page),
		get: (api, id) => api.encoding.inputs.akamaiNetstorage.get(id),
	},
	aspera: {
		list: (api, page) => api.encoding.inputs.aspera.list(page),
		get: (api, id) => api.encoding.inputs.aspera.get(id),
	},
	azure: {
		list: (api, page) => api.encoding.inputs.azure.list(page),
		get: (api, id) => api.encoding.inputs.azure.get(id),
	},
	"direct-file-upload": {
		list: (api, page) => api.encoding.inputs.directFileUpload.list(page),
		get: (api, id) => api.encoding.inputs.directFileUpload.get(id),
	},
	ftp: {
		list: (api, page) => api.encoding.inputs.ftp.list(page),
		get: (api, id) => api.encoding.inputs.ftp.get(id),
	},
	gcs: {
		list: (api, page) => api.encoding.inputs.gcs.list(page),
		get: (api, id) => api.encoding.inputs.gcs.get(id),
	},
	"gcs-service-account": {
		list: (api, page) => api.encoding.inputs.gcsServiceAccount.list(page),
		get: (api, id) => api.encoding.inputs.gcsServiceAccount.get(id),
	},
	"generic-s3": {
		list: (api, page) => api.encoding.inputs.genericS3.list(page),
		get: (api, id) => api.encoding.inputs.genericS3.get(id),
	},
	hls: {
		list: (api, page) => api.encoding.inputs.hls.list(page),
		get: (api, id) => api.encoding.inputs.hls.get(id),
	},
	http: {
		list: (api, page) => api.encoding.inputs.http.list(page),
		get: (api, id) => api.encoding.inputs.http.get(id),
	},
	https: {
		list: (api, page) => api.encoding.inputs.https.list(page),
		get: (api, id) => api.encoding.inputs.https.get(id),
	},
	local: {
		list: (api, page) => api.encoding.inputs.local.list(page),
		get: (api, id) => api.encoding.inputs.local.get(id),
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
	},
	"s3-role-based": {
		list: (api, page) => api.encoding.inputs.s3RoleBased.list(page),
		get: (api, id) => api.encoding.inputs.s3RoleBased.get(id),
	},
	sftp: {
		list: (api, page) => api.encoding.inputs.sftp.list(page),
		get: (api, id) => api.encoding.inputs.sftp.get(id),
	},
	srt: {
		list: (api, page) => api.encoding.inputs.srt.list(page),
		get: (api, id) => api.encoding.inputs.srt.get(id),
	},
	zixi: {
		list: (api, page) => api.encoding.inputs.zixi.list(page),
		get: (api, id) => api.encoding.inputs.zixi.get(id),
	},
} satisfies Record<keyof typeof encodingIoProtocols.inputs, Reader>;

const outputs = {
	"akamai-msl": {
		list: (api, page) => api.encoding.outputs.akamaiMsl.list(page),
		get: (api, id) => api.encoding.outputs.akamaiMsl.get(id),
	},
	"akamai-netstorage": {
		list: (api, page) => api.encoding.outputs.akamaiNetstorage.list(page),
		get: (api, id) => api.encoding.outputs.akamaiNetstorage.get(id),
	},
	azure: {
		list: (api, page) => api.encoding.outputs.azure.list(page),
		get: (api, id) => api.encoding.outputs.azure.get(id),
	},
	cdn: {
		list: (api, page) => api.encoding.outputs.cdn.list(page),
		get: (api, id) => api.encoding.outputs.cdn.get(id),
	},
	ftp: {
		list: (api, page) => api.encoding.outputs.ftp.list(page),
		get: (api, id) => api.encoding.outputs.ftp.get(id),
	},
	gcs: {
		list: (api, page) => api.encoding.outputs.gcs.list(page),
		get: (api, id) => api.encoding.outputs.gcs.get(id),
	},
	"gcs-service-account": {
		list: (api, page) => api.encoding.outputs.gcsServiceAccount.list(page),
		get: (api, id) => api.encoding.outputs.gcsServiceAccount.get(id),
	},
	"generic-s3": {
		list: (api, page) => api.encoding.outputs.genericS3.list(page),
		get: (api, id) => api.encoding.outputs.genericS3.get(id),
	},
	"live-media-ingest": {
		list: (api, page) => api.encoding.outputs.liveMediaIngest.list(page),
		get: (api, id) => api.encoding.outputs.liveMediaIngest.get(id),
	},
	local: {
		list: (api, page) => api.encoding.outputs.local.list(page),
		get: (api, id) => api.encoding.outputs.local.get(id),
	},
	moq: {
		list: (api, page) => api.encoding.outputs.moq.list(page),
		get: (api, id) => api.encoding.outputs.moq.get(id),
	},
	s3: {
		list: (api, page) => api.encoding.outputs.s3.list(page),
		get: (api, id) => api.encoding.outputs.s3.get(id),
	},
	"s3-role-based": {
		list: (api, page) => api.encoding.outputs.s3RoleBased.list(page),
		get: (api, id) => api.encoding.outputs.s3RoleBased.get(id),
	},
	sftp: {
		list: (api, page) => api.encoding.outputs.sftp.list(page),
		get: (api, id) => api.encoding.outputs.sftp.get(id),
	},
} satisfies Record<keyof typeof encodingIoProtocols.outputs, Reader>;

export function encodingIoReader(
	kind: EncodingCatalogueKind,
	protocol?: string,
): Reader | undefined {
	if (!protocol || (kind !== "inputs" && kind !== "outputs")) return;
	const catalogue: Readonly<Record<string, Reader>> =
		kind === "inputs" ? inputs : outputs;
	if (Object.hasOwn(catalogue, protocol)) return catalogue[protocol];
}
