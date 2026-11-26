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
	AwsCloudRegion,
	AzureInput,
	AzureOutput,
	BackupSrtInputs,
	ExternalIdMode,
	GcsInput,
	GcsOutput,
	GcsServiceAccountInput,
	GcsServiceAccountOutput,
	GenericS3Input,
	GenericS3Output,
	GoogleCloudRegion,
	HttpsInput,
	LiveMediaIngestOutput,
	MoqDraftVersion,
	MoqOutput,
	MslPublishingAuthentication,
	RedundantRtmpInput,
	RtmpIngestPoint,
	S3Input,
	S3Output,
	S3RoleBasedInput,
	S3RoleBasedOutput,
	S3SignatureVersion,
	SftpOutput,
	SrtInput,
	SrtMode,
	StaticRtmpIngestPoint,
	StreamKeyConfiguration,
	StreamKeyConfigurationType,
	ZixiInput,
} from "@bitmovin/api-sdk";
import type {
	S3RoleStorageParams,
	SdkOps,
	SrtConnectionParams,
} from "../sdk-ops";
import type { RoleStorageCreateReceipt } from "../stamping-fetch";
import type { OpsContext } from "./context";
import { isBitmovinError, optEnum, sdkEnumValue } from "./shared";

export function createIoOps(
	ctx: OpsContext,
): Pick<
	SdkOps,
	| "createS3Input"
	| "createS3RoleBasedInput"
	| "createAzureInput"
	| "createHttpsInput"
	| "createGenericS3Input"
	| "createGcsInput"
	| "createGcsServiceAccountInput"
	| "createS3Output"
	| "createS3RoleBasedOutput"
	| "createAzureOutput"
	| "createSftpOutput"
	| "createGenericS3Output"
	| "createGcsOutput"
	| "createGcsServiceAccountOutput"
	| "createAkamaiMslOutput"
	| "createLiveMediaIngestOutput"
	| "createMoqOutput"
	| "createAkamaiNetStorageInput"
	| "createAkamaiNetStorageOutput"
	| "createRedundantRtmpInput"
	| "createSrtInput"
	| "createZixiInput"
	| "listRtmpInputs"
> {
	const { api, audited, id, options, stampAuditAdopt } = ctx;
	async function createS3RoleResource(
		direction: "inputs" | "outputs",
		p: S3RoleStorageParams,
	): Promise<string> {
		const path = `/encoding/${direction}/s3-role-based`;
		const journal = options.stamp?.roleStorageCreateJournal?.();
		async function recover(
			receipt: RoleStorageCreateReceipt,
			phase: "pre" | "post-failure",
		) {
			// Name filtering may be non-exact. The full opaque name keeps a normal
			// lookup selective, and the subsequent typed detail must match exactly.
			const lookupName = receipt.lookupName ?? p.name;
			const description = receipt.lookupName
				? p.name
				: `BitOVP role storage create ${receipt.id}`;
			const roleApi =
				direction === "inputs"
					? api.encoding.inputs.s3RoleBased
					: api.encoding.outputs.s3RoleBased;
			let match: string | undefined;
			let complete = false;
			try {
				const limit = 100;
				let total: number | undefined;
				for (let offset = 0; ; offset += limit) {
					const page = await roleApi.list({ name: lookupName, offset, limit });
					const items = page.items;
					if (!items) break;
					const reported =
						page.totalCount ??
						(items.length < limit ? offset + items.length : undefined);
					// Freeze the first page's finite total for older receipts created
					// with the authored name. Later drift requires a new read.
					total ??= reported;
					if (
						total === undefined ||
						!Number.isSafeInteger(total) ||
						total < offset ||
						reported !== total ||
						items.length !== Math.min(limit, total - offset) ||
						(receipt.lookupName && total > limit)
					)
						break;
					for (const item of items) {
						if (
							!item.id ||
							(item.name !== undefined && item.name !== lookupName) ||
							(item.description !== undefined &&
								item.description !== description)
						)
							continue;
						const candidate = await roleApi.get(item.id);
						if (
							candidate.id !== item.id ||
							candidate.description !== description ||
							candidate.name !== lookupName ||
							candidate.bucketName !== p.bucketName ||
							candidate.roleArn !== p.roleArn
						)
							continue;
						if (match && match !== candidate.id)
							throw new Error(
								"More than one role resource matches this receipt",
							);
						match = candidate.id;
					}
					if (offset + items.length === total) {
						complete = true;
						break;
					}
				}
			} catch {
				throw new Error("S3 role-based storage create could not be verified");
			}
			if (!complete || !match)
				throw new Error(
					"S3 role-based storage create is awaiting provider confirmation",
				);
			await stampAuditAdopt(path)(match, phase);
			return match;
		}
		const unresolved = journal?.current();
		if (unresolved) return recover(unresolved, "pre");

		const regionKey = p.region.toUpperCase().replaceAll("-", "_");
		// Leave provider discovery enabled for AWS regions outside the SDK enum.
		const cloudRegion = Object.hasOwn(AwsCloudRegion, regionKey)
			? AwsCloudRegion[regionKey as keyof typeof AwsCloudRegion]
			: undefined;
		const request = {
			name: p.name,
			bucketName: p.bucketName,
			externalIdMode: ExternalIdMode.GLOBAL,
			cloudRegion,
		};
		const receipt = await journal?.reserve();
		const model = {
			...request,
			roleArn: p.roleArn,
			// S3 output customData can break JIT manifests. The provider name
			// carries identity, and the authored name stays in the description.
			...(receipt?.lookupName
				? { name: receipt.lookupName, description: p.name }
				: {}),
		};
		try {
			const resource = await audited(
				"POST",
				path,
				request,
				async () => {
					try {
						return direction === "inputs"
							? await api.encoding.inputs.s3RoleBased.create(
									new S3RoleBasedInput(model),
								)
							: await api.encoding.outputs.s3RoleBased.create(
									new S3RoleBasedOutput(model),
								);
					} catch (error) {
						const message = "S3 role-based storage creation failed";
						if (isBitmovinError(error))
							throw Object.assign(new Error(message), {
								httpStatusCode: error.httpStatusCode,
								errorCode: error.errorCode,
								requestId: error.requestId,
								shortMessage: message,
							});
						throw new Error(message);
					}
				},
				(result) => ({ id: result.id }),
			);
			// AWS checks the provider-managed GLOBAL External ID at usage time.
			return id(resource);
		} catch (error) {
			if (receipt && journal?.current()?.id === receipt.id)
				return recover(receipt, "post-failure");
			throw error;
		}
	}

	return {
		createS3RoleBasedInput: (p) => createS3RoleResource("inputs", p),
		createS3RoleBasedOutput: (p) => createS3RoleResource("outputs", p),
		createMoqOutput: (p) =>
			audited(
				"POST",
				"/encoding/outputs/moq",
				{
					name: p.name,
					trackNamespace: p.trackNamespace,
					draftVersion: p.draftVersion,
					authTokenProvided: p.authToken !== undefined,
				},
				() => {
					const model = new MoqOutput({
						...p,
						draftVersion: sdkEnumValue(
							MoqDraftVersion,
							p.draftVersion,
							"MoqDraftVersion",
						),
					});
					return api.encoding.outputs.moq
						.create(model)
						.catch((error: unknown) => {
							const message = "MoQ output creation failed";
							if (isBitmovinError(error))
								throw Object.assign(new Error(message), {
									httpStatusCode: error.httpStatusCode,
									errorCode: error.errorCode,
									requestId: error.requestId,
									shortMessage: message,
								});
							throw new Error(message);
						});
				},
				(r) => ({ id: r.id }),
			).then(id),
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
				{ name: p.name, host: p.host, ...(p.port ? { port: p.port } : {}) },
				() =>
					api.encoding.inputs.https
						.create(
							new HttpsInput({
								name: p.name,
								host: p.host,
								...(p.port ? { port: p.port } : {}),
								...(p.username !== undefined
									? { username: p.username, password: p.password }
									: {}),
							}),
						)
						.catch((error: unknown) => {
							// The provider can echo Basic credentials in shortMessage.
							// Sanitize before audited() records any provider prose.
							if (p.username === undefined && p.password === undefined)
								throw error;
							const message = "HTTPS input creation failed";
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
