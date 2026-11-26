import type {
	AkamaiMslOutput,
	AkamaiNetStorageOutput,
	AzureOutput,
	GcsOutput,
	GcsServiceAccountOutput,
	GenericS3Output,
	LiveMediaIngestOutput,
	MoqOutput,
	S3Output,
	SftpOutput,
} from "@bitmovin/api-sdk";
import { defineFamily } from "../family";

export const outputs = {
	CREATE_OUTPUT_AKAMAI_MSL: defineFamily<AkamaiMslOutput>({
		parents: [],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id }) => api.encoding.outputs.akamaiMsl.get(id),
		remove: (api, { id }) => api.encoding.outputs.akamaiMsl.delete(id),
	}),
	CREATE_OUTPUT_AKAMAI_NETSTORAGE: defineFamily<AkamaiNetStorageOutput>({
		parents: [],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id }) => api.encoding.outputs.akamaiNetstorage.get(id),
		remove: (api, { id }) => api.encoding.outputs.akamaiNetstorage.delete(id),
	}),
	CREATE_OUTPUT_AZURE: defineFamily<AzureOutput>({
		parents: [],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id }) => api.encoding.outputs.azure.get(id),
		remove: (api, { id }) => api.encoding.outputs.azure.delete(id),
	}),
	CREATE_OUTPUT_GCS: defineFamily<GcsOutput>({
		parents: [],
		fields: ["cloudRegion", "createdAt", "id", "modifiedAt", "name"],
		get: (api, { id }) => api.encoding.outputs.gcs.get(id),
		remove: (api, { id }) => api.encoding.outputs.gcs.delete(id),
	}),
	CREATE_OUTPUT_GCS_SERVICE_ACCOUNT: defineFamily<GcsServiceAccountOutput>({
		parents: [],
		fields: ["cloudRegion", "createdAt", "id", "modifiedAt", "name"],
		get: (api, { id }) => api.encoding.outputs.gcsServiceAccount.get(id),
		remove: (api, { id }) => api.encoding.outputs.gcsServiceAccount.delete(id),
	}),
	CREATE_OUTPUT_GENERIC_S3: defineFamily<GenericS3Output>({
		parents: [],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id }) => api.encoding.outputs.genericS3.get(id),
		remove: (api, { id }) => api.encoding.outputs.genericS3.delete(id),
	}),
	CREATE_OUTPUT_LIVE_MEDIA_INGEST: defineFamily<LiveMediaIngestOutput>({
		parents: [],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id }) => api.encoding.outputs.liveMediaIngest.get(id),
		remove: (api, { id }) => api.encoding.outputs.liveMediaIngest.delete(id),
	}),
	CREATE_OUTPUT_MOQ: defineFamily<MoqOutput>({
		parents: [],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id }) => api.encoding.outputs.moq.get(id),
		remove: (api, { id }) => api.encoding.outputs.moq.delete(id),
	}),
	CREATE_OUTPUT_S3: defineFamily<S3Output>({
		parents: [],
		fields: ["cloudRegion", "createdAt", "id", "modifiedAt", "name"],
		get: (api, { id }) => api.encoding.outputs.s3.get(id),
		remove: (api, { id }) => api.encoding.outputs.s3.delete(id),
	}),
	CREATE_OUTPUT_SFTP: defineFamily<SftpOutput>({
		parents: [],
		fields: ["createdAt", "id", "modifiedAt", "name"],
		get: (api, { id }) => api.encoding.outputs.sftp.get(id),
		remove: (api, { id }) => api.encoding.outputs.sftp.delete(id),
	}),
};
