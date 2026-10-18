/**
 * : io members extracted VERBATIM from sdk-ops.ts. The
 * Pick<SdkOps, …> return type restores the contextual typing the members had
 * inside the monolithic literal; facade-freeze.test.ts pins the union.
 */
import {
	AkamaiMslOutput,
	AkamaiMslStreamFormat,
	AkamaiMslVersion,
	AkamaiNetStorageInput,
	AkamaiNetStorageOutput,
	AzureInput,
	AzureOutput,
	BackupSrtInputs,
	GcsInput,
	GcsOutput,
	GcsServiceAccountInput,
	GcsServiceAccountOutput,
	GenericS3Input,
	GenericS3Output,
	GoogleCloudRegion,
	HttpsInput,
	LiveMediaIngestOutput,
	MslPublishingAuthentication,
	RedundantRtmpInput,
	RtmpIngestPoint,
	S3Input,
	S3Output,
	S3SignatureVersion,
	SftpOutput,
	SrtInput,
	SrtMode,
	StaticRtmpIngestPoint,
	StreamKeyConfiguration,
	StreamKeyConfigurationType,
	ZixiInput,
} from "@bitmovin/api-sdk";
import type { SdkOps, SrtConnectionParams } from "../sdk-ops";
import type { OpsContext } from "./context";
import { isBitmovinError, optEnum, sdkEnumValue } from "./shared";

export function createIoOps(
	ctx: OpsContext,
): Pick<
	SdkOps,
	| "createS3Input"
	| "createAzureInput"
	| "createHttpsInput"
	| "createGenericS3Input"
	| "createGcsInput"
	| "createGcsServiceAccountInput"
	| "createS3Output"
	| "createAzureOutput"
	| "createSftpOutput"
	| "createGenericS3Output"
	| "createGcsOutput"
	| "createGcsServiceAccountOutput"
	| "createAkamaiMslOutput"
	| "createLiveMediaIngestOutput"
	| "createAkamaiNetStorageInput"
	| "createAkamaiNetStorageOutput"
	| "createRedundantRtmpInput"
	| "createSrtInput"
	| "createZixiInput"
	| "listRtmpInputs"
> {
	const { api, audited, id } = ctx;
	return {
		createLiveMediaIngestOutput: (p) =>
			audited(
				"POST",
				"/encoding/outputs/live-media-ingest",
				{ name: p.name, scte35Passthrough: p.scte35Passthrough },
				() =>
					api.encoding.outputs.liveMediaIngest
						.create(new LiveMediaIngestOutput(p))
						.catch((error: unknown) => {
							const message = "Live Media Ingest output creation failed";
							if (isBitmovinError(error))
								throw Object.assign(new Error(message), {
									httpStatusCode: error.httpStatusCode,
									errorCode: error.errorCode,
									requestId: error.requestId,
									shortMessage: message,
								});
							throw new Error(message);
						}),
				(r) => ({ id: r.id }),
			).then(id),
		createS3Input: (p) =>
			audited(
				"POST",
				"/encoding/inputs/s3",
				{ name: p.name, bucketName: p.bucketName },
				() =>
					api.encoding.inputs.s3.create(
						new S3Input({
							name: p.name,
							bucketName: p.bucketName,
							accessKey: p.accessKey,
							secretKey: p.secretKey,
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createAzureInput: (p) =>
			audited(
				"POST",
				"/encoding/inputs/azure",
				{ name: p.name, container: p.container },
				() =>
					api.encoding.inputs.azure.create(
						new AzureInput({
							name: p.name,
							container: p.container,
							accountName: p.accountName,
							accountKey: p.accountKey,
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createHttpsInput: (p) =>
			audited(
				"POST",
				"/encoding/inputs/https",
				p,
				() =>
					api.encoding.inputs.https.create(
						new HttpsInput({ name: p.name, host: p.host }),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createGenericS3Input: (p) =>
			audited(
				"POST",
				"/encoding/inputs/generic-s3",
				// Snapshot is secret-free: host/port/ssl identify the endpoint; the
				// access/secret keys are deliberately omitted (and redactSecrets
				// would mask them anyway).
				{
					name: p.name,
					bucketName: p.bucketName,
					host: p.host,
					port: p.port,
					ssl: p.ssl,
					signatureVersion: p.signatureVersion,
				},
				() =>
					api.encoding.inputs.genericS3.create(
						new GenericS3Input({
							name: p.name,
							bucketName: p.bucketName,
							host: p.host,
							port: p.port,
							ssl: p.ssl,
							signatureVersion: optEnum(
								S3SignatureVersion,
								p.signatureVersion,
								"S3SignatureVersion",
							),
							accessKey: p.accessKey,
							secretKey: p.secretKey,
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createGcsInput: (p) =>
			audited(
				"POST",
				"/encoding/inputs/gcs",
				{ name: p.name, bucketName: p.bucketName, cloudRegion: p.cloudRegion },
				() =>
					api.encoding.inputs.gcs.create(
						new GcsInput({
							name: p.name,
							bucketName: p.bucketName,
							cloudRegion: optEnum(
								GoogleCloudRegion,
								p.cloudRegion,
								"GoogleCloudRegion",
							),
							accessKey: p.accessKey,
							secretKey: p.secretKey,
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createGcsServiceAccountInput: (p) =>
			audited(
				"POST",
				"/encoding/inputs/gcs-service-account",
				// serviceAccountCredentials is the JSON key — NEVER snapshotted.
				{ name: p.name, bucketName: p.bucketName, cloudRegion: p.cloudRegion },
				() =>
					api.encoding.inputs.gcsServiceAccount.create(
						new GcsServiceAccountInput({
							name: p.name,
							bucketName: p.bucketName,
							cloudRegion: optEnum(
								GoogleCloudRegion,
								p.cloudRegion,
								"GoogleCloudRegion",
							),
							serviceAccountCredentials: p.serviceAccountCredentials,
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createS3Output: (p) =>
			audited(
				"POST",
				"/encoding/outputs/s3",
				{ name: p.name, bucketName: p.bucketName },
				() =>
					api.encoding.outputs.s3.create(
						new S3Output({
							name: p.name,
							bucketName: p.bucketName,
							accessKey: p.accessKey,
							secretKey: p.secretKey,
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createAzureOutput: (p) =>
			audited(
				"POST",
				"/encoding/outputs/azure",
				{ name: p.name, container: p.container },
				() =>
					api.encoding.outputs.azure.create(
						new AzureOutput({
							name: p.name,
							container: p.container,
							accountName: p.accountName,
							accountKey: p.accountKey,
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createAkamaiNetStorageInput: (p) =>
			audited(
				"POST",
				"/encoding/inputs/akamai-netstorage",
				// Username and password are withheld from the audit snapshot,
				// exactly as the SFTP factory below withholds them: a snapshot
				// is read by humans and stored, and NetStorage credentials are
				// vault material .
				{ name: p.name, host: p.host },
				() =>
					api.encoding.inputs.akamaiNetstorage.create(
						new AkamaiNetStorageInput({
							name: p.name,
							host: p.host,
							username: p.username,
							password: p.password,
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createAkamaiNetStorageOutput: (p) =>
			audited(
				"POST",
				"/encoding/outputs/akamai-netstorage",
				{ name: p.name, host: p.host },
				() =>
					api.encoding.outputs.akamaiNetstorage.create(
						new AkamaiNetStorageOutput({
							name: p.name,
							host: p.host,
							username: p.username,
							password: p.password,
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createSftpOutput: (p) =>
			audited(
				"POST",
				"/encoding/outputs/sftp",
				{ name: p.name, host: p.host, port: p.port },
				() =>
					api.encoding.outputs.sftp.create(
						new SftpOutput({
							name: p.name,
							host: p.host,
							port: p.port,
							username: p.username,
							password: p.password,
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createGenericS3Output: (p) =>
			audited(
				"POST",
				"/encoding/outputs/generic-s3",
				{
					name: p.name,
					bucketName: p.bucketName,
					host: p.host,
					port: p.port,
					ssl: p.ssl,
					signatureVersion: p.signatureVersion,
				},
				() =>
					api.encoding.outputs.genericS3.create(
						new GenericS3Output({
							name: p.name,
							bucketName: p.bucketName,
							host: p.host,
							port: p.port,
							ssl: p.ssl,
							signatureVersion: optEnum(
								S3SignatureVersion,
								p.signatureVersion,
								"S3SignatureVersion",
							),
							accessKey: p.accessKey,
							secretKey: p.secretKey,
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createGcsOutput: (p) =>
			audited(
				"POST",
				"/encoding/outputs/gcs",
				{ name: p.name, bucketName: p.bucketName, cloudRegion: p.cloudRegion },
				() =>
					api.encoding.outputs.gcs.create(
						new GcsOutput({
							name: p.name,
							bucketName: p.bucketName,
							cloudRegion: optEnum(
								GoogleCloudRegion,
								p.cloudRegion,
								"GoogleCloudRegion",
							),
							accessKey: p.accessKey,
							secretKey: p.secretKey,
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createAkamaiMslOutput: (p) =>
			audited(
				"POST",
				"/encoding/outputs/akamai-msl",
				// The Digest pair goes to the SDK and is DESTRUCTURED out of
				// this literal — the rule the interface note above wrote down
				// before the field existed (#162, F1). One flag, not two:
				// the pair is atomic under the caller's AND guard, which
				// throws while this argument object is still being evaluated,
				// so a half-filled credential never produces an audit row for
				// two flags to disagree in.
				{
					name: p.name,
					streamId: p.streamId,
					eventName: p.eventName,
					streamFormat: p.streamFormat,
					mslVersion: p.mslVersion,
					publishingAuthProvided: p.publishingAuthentication !== undefined,
				},
				() =>
					api.encoding.outputs.akamaiMsl.create(
						new AkamaiMslOutput({
							name: p.name,
							streamId: p.streamId,
							eventName: p.eventName,
							streamFormat: sdkEnumValue(
								AkamaiMslStreamFormat,
								p.streamFormat,
								"AkamaiMslStreamFormat",
							),
							mslVersion: sdkEnumValue(
								AkamaiMslVersion,
								p.mslVersion,
								"AkamaiMslVersion",
							),
							...(p.publishingAuthentication
								? {
										publishingAuthentication: new MslPublishingAuthentication(
											p.publishingAuthentication,
										),
									}
								: {}),
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createGcsServiceAccountOutput: (p) =>
			audited(
				"POST",
				"/encoding/outputs/gcs-service-account",
				{ name: p.name, bucketName: p.bucketName, cloudRegion: p.cloudRegion },
				() =>
					api.encoding.outputs.gcsServiceAccount.create(
						new GcsServiceAccountOutput({
							name: p.name,
							bucketName: p.bucketName,
							cloudRegion: optEnum(
								GoogleCloudRegion,
								p.cloudRegion,
								"GoogleCloudRegion",
							),
							serviceAccountCredentials: p.serviceAccountCredentials,
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createRedundantRtmpInput: (p) =>
			audited(
				"POST",
				"/encoding/inputs/redundant-rtmp",
				// Ingest-point streamKeys are connection-routing material — the
				// snapshot carries them and writeAuditLog's redactSecrets masks
				// them at persistence (ledger exception; no vault material here).
				p,
				() =>
					api.encoding.inputs.redundantRtmp.create(
						new RedundantRtmpInput({
							name: p.name,
							delayThreshold: p.delayThreshold,
							ingestPoints: p.ingestPoints?.map(
								(point) => new RtmpIngestPoint(point),
							),
							staticIngestPoints: p.staticIngestPoints?.map(
								(point) =>
									new StaticRtmpIngestPoint({
										name: point.name,
										streamKeyConfiguration: point.streamKeyConfiguration
											? new StreamKeyConfiguration({
													type: sdkEnumValue(
														StreamKeyConfigurationType,
														point.streamKeyConfiguration.type,
														"StreamKeyConfigurationType",
													),
													streamKeyId: point.streamKeyConfiguration.streamKeyId,
												})
											: undefined,
									}),
							),
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createSrtInput: (p) => {
			// Passphrases NEVER enter the snapshot — only their presence.
			const connectionSnapshot = (c: SrtConnectionParams) => ({
				mode: c.mode,
				host: c.host,
				port: c.port,
				path: c.path,
				latency: c.latency,
				keyLength: c.keyLength,
				hasPassphrase: c.passphrase !== undefined,
			});
			const connectionModel = (c: SrtConnectionParams) => ({
				mode: sdkEnumValue(SrtMode, c.mode, "SrtMode"),
				host: c.host,
				port: c.port,
				path: c.path,
				latency: c.latency,
				passphrase: c.passphrase,
				keyLength: c.keyLength,
			});
			return audited(
				"POST",
				"/encoding/inputs/srt",
				{
					name: p.name,
					...connectionSnapshot(p),
					...(p.backupSrtInputs
						? {
								backupSrtInputs: {
									delayThreshold: p.backupSrtInputs.delayThreshold,
									srtInputs:
										p.backupSrtInputs.srtInputs.map(connectionSnapshot),
								},
							}
						: {}),
				},
				() =>
					api.encoding.inputs.srt.create(
						new SrtInput({
							name: p.name,
							...connectionModel(p),
							backupSrtInputs: p.backupSrtInputs
								? new BackupSrtInputs({
										delayThreshold: p.backupSrtInputs.delayThreshold,
										srtInputs: p.backupSrtInputs.srtInputs.map(
											(backup) => new SrtInput(connectionModel(backup)),
										),
									})
								: undefined,
						}),
					),
				(r) => ({ id: r.id }),
			).then(id);
		},

		createZixiInput: (p) =>
			audited(
				"POST",
				"/encoding/inputs/zixi",
				// password/decryptionKey NEVER enter the snapshot.
				{
					name: p.name,
					host: p.host,
					port: p.port,
					stream: p.stream,
					latency: p.latency,
					minBitrate: p.minBitrate,
					decryptionType: p.decryptionType,
					hasPassword: p.password !== undefined,
					hasDecryptionKey: p.decryptionKey !== undefined,
				},
				() =>
					api.encoding.inputs.zixi.create(
						new ZixiInput({
							name: p.name,
							host: p.host,
							port: p.port,
							stream: p.stream,
							password: p.password,
							latency: p.latency,
							minBitrate: p.minBitrate,
							decryptionType: p.decryptionType,
							decryptionKey: p.decryptionKey,
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		listRtmpInputs: async () => {
			// C6: limit ≤ 100, paginate to exhaustion. Read — not audited.
			const limit = 100;
			const inputs: { id: string; name?: string }[] = [];
			for (let offset = 0; ; offset += limit) {
				const response = await api.encoding.inputs.rtmp.list({ offset, limit });
				const items = response.items ?? [];
				for (const input of items) {
					if (!input.id) {
						throw new Error("RTMP input list returned an entry without id");
					}
					inputs.push({ id: input.id, name: input.name });
				}
				if (items.length < limit) {
					return inputs;
				}
			}
		},
	};
}
