import "server-only";

import {
	AsperaInput,
	AzureSpeechServicesCredentials,
	AzureSpeechToCaptionsFilter,
	AzureSpeechToCaptionsSettings,
	CheckOutputPermissionsRequest,
	DirectFileUploadInput,
	FtpInput,
	FtpOutput,
	HttpInput,
	LocalInput,
	LocalOutput,
	SftpInput,
	WatchFolder,
	WatchFolderInput,
	WatchFolderOutput,
} from "@bitmovin/api-sdk";
import { z } from "zod";
import {
	type NativeOperation,
	type NativeOperationAction,
	nativeOperationUuid,
} from "@/lib/native-account-operations";
import { bitmovinClientFromBinding } from "./bitmovin";

type Binding = Parameters<typeof bitmovinClientFromBinding>[0];
type AccountApi = ReturnType<typeof bitmovinClientFromBinding>;
type ResourceTarget = Extract<NativeOperation, { resourceId: string }>;
type PathPair = Extract<NativeOperation, { inputId: string }>;
type Accepted = { providerId: string; uploadUrl?: string; passed?: boolean };

const envelope = z.object({
	status: z.literal("SUCCESS"),
	data: z.object({ result: z.unknown() }),
});
const resource = z.object({
	id: nativeOperationUuid,
	type: z.string().optional(),
});
const watchResource = resource.extend({
	status: z.enum(["STOPPED", "STARTED", "ERROR"]),
});
const probeResponse = z.object({
	outputId: nativeOperationUuid,
	outputType: z.literal("S3"),
	path: z.string(),
	passed: z.boolean(),
});
const templateStarted = z.object({ encodingId: nativeOperationUuid });
const upload = resource.extend({
	uploadUrl: z.url({ protocol: /^https$/ }).refine((value) => {
		const url = new URL(value);
		return !url.username && !url.password;
	}),
});

const resourceTypes: Partial<Record<NativeOperationAction, string>> = {
	"create-aspera-input": "ASPERA",
	"delete-aspera-input": "ASPERA",
	"create-direct-upload": "DIRECT_FILE_UPLOAD",
	"delete-direct-upload": "DIRECT_FILE_UPLOAD",
	"create-ftp-input": "FTP",
	"delete-ftp-input": "FTP",
	"create-http-input": "HTTP",
	"delete-http-input": "HTTP",
	"create-local-input": "LOCAL",
	"delete-local-input": "LOCAL",
	"create-sftp-input": "SFTP",
	"delete-sftp-input": "SFTP",
	"create-ftp-output": "FTP",
	"delete-ftp-output": "FTP",
	"create-local-output": "LOCAL",
	"delete-local-output": "LOCAL",
	"create-azure-captions": "AZURE_SPEECH_TO_CAPTIONS",
	"delete-azure-captions": "AZURE_SPEECH_TO_CAPTIONS",
	"create-template": "VOD",
	"delete-template": "VOD",
	"check-s3-output": "S3",
};

function observe(
	binding: Binding,
	signal: AbortSignal,
	beforeFetch?: () => void,
) {
	let raw: unknown;
	let noContent = false;
	const api = bitmovinClientFromBinding(
		binding,
		signal,
		async (_url, response) => {
			raw = undefined;
			noContent = response.status === 204;
			if (response.ok && !noContent)
				raw = envelope.parse(await response.clone().json()).data.result;
		},
		beforeFetch,
	);
	return { api, raw: () => raw, noContent: () => noContent };
}

function providerStatus(error: unknown) {
	return (error as { httpStatusCode?: unknown } | null)?.httpStatusCode;
}

export class NativeProviderTargetError extends Error {
	constructor(readonly status: 404 | 409) {
		super(
			status === 404
				? "Resource not found in this Bitmovin account."
				: "The resource state changed. Refresh the resource.",
		);
	}
}

export function providerRefusedNativeOperation(
	error: unknown,
	action: NativeOperationAction,
) {
	// Template start can leave partially created resources before a rejection.
	return (
		action !== "start-template" &&
		[400, 401, 403, 404, 409, 422].includes(Number(providerStatus(error)))
	);
}

async function readTarget(
	api: AccountApi,
	{ action, resourceId: id }: ResourceTarget,
) {
	switch (action) {
		case "delete-aspera-input":
			return api.encoding.inputs.aspera.get(id);
		case "delete-direct-upload":
			return api.encoding.inputs.directFileUpload.get(id);
		case "delete-ftp-input":
			return api.encoding.inputs.ftp.get(id);
		case "delete-http-input":
			return api.encoding.inputs.http.get(id);
		case "delete-local-input":
			return api.encoding.inputs.local.get(id);
		case "delete-sftp-input":
			return api.encoding.inputs.sftp.get(id);
		case "delete-ftp-output":
			return api.encoding.outputs.ftp.get(id);
		case "delete-local-output":
			return api.encoding.outputs.local.get(id);
		case "delete-azure-captions":
			return api.encoding.filters.azureSpeechToCaptions.get(id);
		case "delete-template":
			return api.encoding.templates.get(id);
		case "delete-watch-folder":
		case "start-watch-folder":
		case "stop-watch-folder":
			return api.encoding.watchFolders.get(id);
		case "check-s3-output":
			return api.encoding.outputs.s3.get(id);
	}
}

const objectStorage = new Set([
	"S3",
	"S3_ROLE_BASED",
	"GCS",
	"GCS_SERVICE_ACCOUNT",
]);
const mediaInputs = new Set([
	...objectStorage,
	"HTTP",
	"HTTPS",
	"DIRECT_FILE_UPLOAD",
]);
const watchStorage = new Set(["S3", "S3_ROLE_BASED"]);

function checkIdentity(
	raw: unknown,
	id: string,
	permitted: ReadonlySet<string>,
) {
	const parsed = resource.safeParse(raw);
	if (
		!parsed.success ||
		parsed.data.id !== id ||
		!permitted.has(parsed.data.type ?? "")
	)
		throw new NativeProviderTargetError(404);
}

export async function checkNativeProviderTargets(
	binding: Binding,
	command: NativeOperation,
	signal: AbortSignal,
) {
	const observed = observe(binding, signal);
	const { api } = observed;
	try {
		if ("inputId" in command) {
			const watching = command.action === "create-watch-folder";
			await api.encoding.inputs.get(command.inputId);
			checkIdentity(
				observed.raw(),
				command.inputId,
				watching ? watchStorage : mediaInputs,
			);
			await api.encoding.outputs.get(command.outputId);
			checkIdentity(
				observed.raw(),
				command.outputId,
				watching ? watchStorage : objectStorage,
			);
		} else if ("resourceId" in command) {
			await readTarget(api, command);
			const raw = observed.raw();
			const parsed = resource.safeParse(raw);
			const expected = resourceTypes[command.action];
			if (
				!parsed.success ||
				parsed.data.id !== command.resourceId ||
				(expected !== undefined &&
					parsed.data.type !== undefined &&
					parsed.data.type !== expected)
			)
				throw new NativeProviderTargetError(404);
			if (
				command.action === "start-watch-folder" ||
				command.action === "stop-watch-folder" ||
				command.action === "delete-watch-folder"
			) {
				const watch = watchResource.safeParse(raw);
				const shouldBeStopped = command.action !== "stop-watch-folder";
				if (
					!watch.success ||
					(watch.data.status === "STOPPED") !== shouldBeStopped
				)
					throw new NativeProviderTargetError(409);
			}
		}
	} catch (error) {
		if (providerStatus(error) === 404) throw new NativeProviderTargetError(404);
		throw error;
	}
}

const encodingReference = "$/encodings/mp4";
const configurationReference = "$/configurations";

// Keep the property order required by the Encoding Templates API. The form
// identifies storage resources and paths; the application defines the recipe.
function mp4Template(command: PathPair, outputPath: string) {
	const { name, inputId, inputPath, outputId } = command;
	return {
		metadata: { type: "VOD", name },
		configurations: {
			video: {
				h264: {
					video: {
						properties: { profile: "MAIN", height: 720, bitrate: 2_000_000 },
					},
				},
			},
			audio: {
				aac: { audio: { properties: { bitrate: 128_000, rate: 48_000 } } },
			},
		},
		encodings: {
			mp4: {
				properties: { name, cloudRegion: "AUTO", encoderVersion: "STABLE" },
				streams: {
					video: {
						properties: {
							inputStreams: [
								{
									inputId,
									inputPath,
									selectionMode: "VIDEO_RELATIVE",
									position: 0,
								},
							],
							codecConfigId: `${configurationReference}/video/h264/video`,
						},
					},
					audio: {
						properties: {
							inputStreams: [
								{
									inputId,
									inputPath,
									selectionMode: "AUDIO_RELATIVE",
									position: 0,
								},
							],
							codecConfigId: `${configurationReference}/audio/aac/audio`,
						},
					},
				},
				muxings: {
					mp4: {
						video: {
							properties: {
								filename: "video.mp4",
								streams: [
									{ streamId: `${encodingReference}/streams/video` },
									{ streamId: `${encodingReference}/streams/audio` },
								],
								outputs: [
									{ outputId, outputPath, acl: [{ permission: "PRIVATE" }] },
								],
							},
						},
					},
				},
				start: { properties: { encodingMode: "SINGLE_PASS" } },
			},
		},
	};
}

function location(command: Extract<NativeOperation, { host: string }>) {
	return {
		name: command.name,
		host: command.host,
		username: command.username,
		password: command.password,
	};
}

async function write(api: AccountApi, command: NativeOperation, id: string) {
	switch (command.action) {
		case "create-aspera-input":
			return api.encoding.inputs.aspera.create(
				new AsperaInput({
					...location(command),
					token: command.token,
					sshPort: command.sshPort,
					faspPort: command.faspPort,
				}),
			);
		case "delete-aspera-input":
			return api.encoding.inputs.aspera.delete(command.resourceId);
		case "create-direct-upload":
			return api.encoding.inputs.directFileUpload.create(
				new DirectFileUploadInput({ name: command.name }),
			);
		case "delete-direct-upload":
			return api.encoding.inputs.directFileUpload.delete(command.resourceId);
		case "create-ftp-input":
			return api.encoding.inputs.ftp.create(
				new FtpInput({
					...location(command),
					port: command.port,
					passive: command.passive,
				}),
			);
		case "delete-ftp-input":
			return api.encoding.inputs.ftp.delete(command.resourceId);
		case "create-http-input":
			return api.encoding.inputs.http.create(
				new HttpInput({ ...location(command), port: command.port }),
			);
		case "delete-http-input":
			return api.encoding.inputs.http.delete(command.resourceId);
		case "create-local-input":
			return api.encoding.inputs.local.create(
				new LocalInput({ name: command.name, path: command.path }),
			);
		case "delete-local-input":
			return api.encoding.inputs.local.delete(command.resourceId);
		case "create-sftp-input":
			return api.encoding.inputs.sftp.create(
				new SftpInput({ ...location(command), port: command.port }),
			);
		case "delete-sftp-input":
			return api.encoding.inputs.sftp.delete(command.resourceId);
		case "create-ftp-output":
			return api.encoding.outputs.ftp.create(
				new FtpOutput({
					...location(command),
					port: command.port,
					passive: command.passive,
				}),
			);
		case "delete-ftp-output":
			return api.encoding.outputs.ftp.delete(command.resourceId);
		case "create-local-output":
			return api.encoding.outputs.local.create(
				new LocalOutput({ name: command.name, path: command.path }),
			);
		case "delete-local-output":
			return api.encoding.outputs.local.delete(command.resourceId);
		case "create-azure-captions":
			return api.encoding.filters.azureSpeechToCaptions.create(
				new AzureSpeechToCaptionsFilter({
					name: command.name,
					azureSpeechToCaptionsSettings: new AzureSpeechToCaptionsSettings({
						region: command.region,
						language: command.language,
						azureSpeechServicesCredentials: new AzureSpeechServicesCredentials({
							subscriptionKey: command.subscriptionKey,
						}),
					}),
				}),
			);
		case "delete-azure-captions":
			return api.encoding.filters.azureSpeechToCaptions.delete(
				command.resourceId,
			);
		case "create-template":
			return api.encoding.templates.create(
				mp4Template(command, command.outputPath),
			);
		case "start-template":
			return api.encoding.templates.start(
				mp4Template(command, `${command.outputPath}/${id}/`),
			);
		case "delete-template":
			return api.encoding.templates.delete(command.resourceId);
		case "create-watch-folder":
			return api.encoding.watchFolders.create(
				new WatchFolder({
					name: command.name,
					input: new WatchFolderInput({
						inputId: command.inputId,
						inputPath: command.inputPath,
					}),
					outputs: [
						new WatchFolderOutput({
							outputId: command.outputId,
							outputPath: command.outputPath,
						}),
					],
				}),
			);
		case "delete-watch-folder":
			return api.encoding.watchFolders.delete(command.resourceId);
		case "start-watch-folder":
			return api.encoding.watchFolders.start(command.resourceId);
		case "stop-watch-folder":
			return api.encoding.watchFolders.stop(command.resourceId);
		case "check-s3-output":
			return api.encoding.outputs.checkPermissions(
				command.resourceId,
				new CheckOutputPermissionsRequest({
					path: probePath(command.path, id),
				}),
			);
	}
}

function probePath(prefix: string, id: string) {
	return `${prefix}/.bitovp-permissions-${id}/`;
}

export async function dispatchNativeProviderOperation(
	binding: Binding,
	command: NativeOperation,
	id: string,
	signal: AbortSignal,
	beforeFetch: () => void,
): Promise<Accepted> {
	const observed = observe(binding, signal, beforeFetch);
	await write(observed.api, command, id);
	const raw = observed.raw();
	if (command.action === "start-template")
		return { providerId: templateStarted.parse(raw).encodingId };
	if (command.action === "check-s3-output") {
		const check = probeResponse.parse(raw);
		if (
			check.outputId !== command.resourceId ||
			check.path !== probePath(command.path, id)
		)
			throw new Error("Bitmovin permission response mismatch");
		return { providerId: check.outputId, passed: check.passed };
	}
	if (
		"resourceId" in command &&
		command.action.startsWith("delete-") &&
		observed.noContent()
	)
		return { providerId: command.resourceId };
	const result = resource.parse(raw);
	const expected = resourceTypes[command.action];
	if (
		expected !== undefined &&
		result.type !== undefined &&
		result.type !== expected
	)
		throw new Error("Bitmovin operation resource type mismatch");
	if ("resourceId" in command && result.id !== command.resourceId)
		throw new Error("Bitmovin operation resource ID mismatch");
	return {
		providerId: result.id,
		...(command.action === "create-direct-upload" && {
			uploadUrl: upload.parse(raw).uploadUrl,
		}),
	};
}
