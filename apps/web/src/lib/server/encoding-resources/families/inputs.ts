import type {
	AkamaiNetStorageInput,
	AzureInput,
	GcsInput,
	GcsServiceAccountInput,
	GenericS3Input,
	HlsInput,
	HttpsInput,
	RedundantRtmpInput,
	S3Input,
	S3RoleBasedInput,
	SrtInput,
	ZixiInput,
} from "@bitmovin/api-sdk";
import { defineFamily } from "../family";

export const inputs = {
	CREATE_INPUT_AKAMAI_NETSTORAGE: defineFamily<AkamaiNetStorageInput>({
		parents: [],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id }) => api.encoding.inputs.akamaiNetstorage.get(id),
		remove: (api, { id }) => api.encoding.inputs.akamaiNetstorage.delete(id),
	}),
	CREATE_INPUT_AZURE: defineFamily<AzureInput>({
		parents: [],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id }) => api.encoding.inputs.azure.get(id),
		remove: (api, { id }) => api.encoding.inputs.azure.delete(id),
	}),
	CREATE_INPUT_GCS: defineFamily<GcsInput>({
		parents: [],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id }) => api.encoding.inputs.gcs.get(id),
		remove: (api, { id }) => api.encoding.inputs.gcs.delete(id),
	}),
	CREATE_INPUT_GCS_SERVICE_ACCOUNT: defineFamily<GcsServiceAccountInput>({
		parents: [],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id }) => api.encoding.inputs.gcsServiceAccount.get(id),
		remove: (api, { id }) => api.encoding.inputs.gcsServiceAccount.delete(id),
	}),
	CREATE_INPUT_GENERIC_S3: defineFamily<GenericS3Input>({
		parents: [],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id }) => api.encoding.inputs.genericS3.get(id),
		remove: (api, { id }) => api.encoding.inputs.genericS3.delete(id),
	}),
	CREATE_INPUT_HLS_LIVE: defineFamily<HlsInput>({
		parents: [],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id }) => api.encoding.inputs.hls.get(id),
		remove: (api, { id }) => api.encoding.inputs.hls.delete(id),
	}),
	CREATE_INPUT_HTTPS: defineFamily<HttpsInput>({
		parents: [],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id }) => api.encoding.inputs.https.get(id),
		remove: (api, { id }) => api.encoding.inputs.https.delete(id),
	}),
	CREATE_INPUT_REDUNDANT_RTMP: defineFamily<RedundantRtmpInput>({
		parents: [],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id }) => api.encoding.inputs.redundantRtmp.get(id),
		remove: (api, { id }) => api.encoding.inputs.redundantRtmp.delete(id),
	}),
	CREATE_INPUT_S3: defineFamily<S3Input>({
		parents: [],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id }) => api.encoding.inputs.s3.get(id),
		remove: (api, { id }) => api.encoding.inputs.s3.delete(id),
	}),
	CREATE_INPUT_S3_ROLE_BASED: defineFamily<S3RoleBasedInput>({
		parents: [],
		fields: ["cloudRegion", "createdAt", "id", "modifiedAt", "name"],
		get: (api, { id }) => api.encoding.inputs.s3RoleBased.get(id),
		remove: (api, { id }) => api.encoding.inputs.s3RoleBased.delete(id),
	}),
	CREATE_INPUT_SRT: defineFamily<SrtInput>({
		parents: [],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id }) => api.encoding.inputs.srt.get(id),
		remove: (api, { id }) => api.encoding.inputs.srt.delete(id),
	}),
	CREATE_INPUT_ZIXI: defineFamily<ZixiInput>({
		parents: [],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id }) => api.encoding.inputs.zixi.get(id),
		remove: (api, { id }) => api.encoding.inputs.zixi.delete(id),
	}),
};
