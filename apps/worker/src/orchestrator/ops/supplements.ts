import {
	Bif,
	BurnInSubtitleAssa,
	BurnInSubtitleDvbSub,
	CaptionCharacterEncoding,
	Cea608ChannelType,
	ConvertSccCaption,
	InputPath,
	SccCaption,
	Scte35Trigger,
	SmpteTimecodeFlavor,
	SrtToCea608708Caption,
	StreamCaptionOutputFormat,
	WebVttSidecarFile,
} from "@bitmovin/api-sdk";
import { withProviderCreateRefusal } from "../provider-create-refusal";
import type { SdkOps } from "../sdk-ops";
import type { OpsContext } from "./context";
import {
	adoptOrCreateStamped,
	findStampedResource,
	optEnum,
	outputs,
	sdkEnumValue,
} from "./shared";

type Result = { id?: string; customData?: unknown };
type Paging = { offset: number; limit: number };

export class SupplementOutputPreflightError extends Error {}

function required<T>(value: T | undefined, name: string): T {
	if (value === undefined) throw new Error(`Encoding supplement needs ${name}`);
	return value;
}

export function createSupplementOps(
	ctx: OpsContext,
): Pick<SdkOps, "createEncodingSupplement"> {
	const { api, audited, id, options, stampAuditAdopt } = ctx;
	return {
		async createEncodingSupplement(encodingId, item, refs) {
			if (refs.azureOutputIds && options.stamp?.adoptWindow?.() !== true) {
				// Vault credentials can authenticate to the same storage account.
				// Read the provider outputs to check the targets even after a retry.
				const targets = await Promise.all(
					refs.azureOutputIds.map(async (outputId) => {
						const output = await api.encoding.outputs.azure.get(outputId);
						if (
							output.id !== outputId ||
							!output.accountName ||
							!output.container
						)
							return undefined;
						return JSON.stringify([
							output.accountName.toLowerCase(),
							output.container,
						]);
					}),
				).catch(() => undefined);
				if (!targets?.length || targets.includes(undefined))
					throw new SupplementOutputPreflightError(
						"Could not verify the Azure supplement destinations",
					);
				if (new Set(targets).size !== targets.length)
					throw new SupplementOutputPreflightError(
						"Choose distinct Azure storage for the supplement and its mirrors",
					);
			}
			const encodingPath = `/encoding/encodings/${encodingId}`;
			const streamId = () => required(refs.streamId, "stream");
			const streamPath = () => `${encodingPath}/streams/${streamId()}`;
			const input = (inputPath: string) =>
				new InputPath({ inputId: required(refs.inputId, "input"), inputPath });
			const destination = () => outputs(required(refs.destination, "output"));
			const encodings = api.encoding.encodings;

			const createStamped = <T extends Result>(args: {
				path: string;
				body: object;
				create: () => Promise<T>;
				list: (page: Paging) => Promise<{ items?: T[] }>;
				readIdentity: (resourceId: string) => Promise<{ customData?: unknown }>;
			}) =>
				adoptOrCreateStamped({
					label: item.kind,
					stamp: options.stamp && {
						...options.stamp,
						allowCreate: () =>
							options.stamp?.adoptWindow?.() !== true &&
							options.stamp?.allowCreate?.() !== false,
					},
					lookup: (expect) =>
						findStampedResource({
							label: item.kind,
							expect,
							list: args.list,
							customData: args.readIdentity,
						}),
					create: () =>
						audited(
							"POST",
							args.path,
							args.body,
							() => withProviderCreateRefusal(args.create),
							(result) => ({
								id: result.id,
							}),
						).then(id),
					auditAdopt: stampAuditAdopt(args.path),
				});

			switch (item.kind) {
				case "SCC_CONVERSION": {
					const body = new ConvertSccCaption({
						input: input(item.inputPath),
						outputs: destination(),
						fileName: item.filename,
						outputFormat: StreamCaptionOutputFormat.WEBVTT,
					});
					return createStamped({
						path: `${encodingPath}/captions/scc`,
						body,
						create: () =>
							api.encoding.encodings.captions.scc.create(encodingId, body),
						list: (page) => encodings.captions.scc.list(encodingId, page),
						readIdentity: (resourceId) =>
							encodings.captions.scc.customdata.get(encodingId, resourceId),
					});
				}
				case "SIDECAR":
				case "WEBVTT_SIDECAR": {
					const body = new WebVttSidecarFile({
						inputId: required(refs.inputId, "input"),
						inputPath: item.inputPath,
						outputs: destination(),
					});
					const generic = item.kind === "SIDECAR";
					return createStamped({
						path: `${encodingPath}/sidecars${generic ? "" : "/webvtt"}`,
						body,
						create: () =>
							generic
								? api.encoding.encodings.sidecars.create(encodingId, body)
								: api.encoding.encodings.sidecars.webvtt.create(
										encodingId,
										body,
									),
						list: (page) => encodings.sidecars.webvtt.list(encodingId, page),
						readIdentity: (resourceId) =>
							encodings.sidecars.customdata.get(encodingId, resourceId),
					});
				}
				case "SCTE35_TRIGGER": {
					const path = `${encodingPath}/scte-35-triggers`;
					if (options.stamp?.adoptWindow?.()) {
						const result = await encodings.scte35Triggers.list(encodingId, {
							offset: 0,
							limit: 100,
						});
						const exact =
							result.items?.filter(
								(candidate) =>
									candidate.base64EncodedMetadata ===
									item.base64EncodedMetadata,
							) ?? [];
						const existing = exact.length === 1 ? exact[0]?.id : undefined;
						if (existing && result.totalCount === result.items?.length) {
							await stampAuditAdopt(path)(existing, "pre");
							return existing;
						}
						throw new Error(
							"SCTE-35 trigger outcome could not be recovered on this encoding",
						);
					}
					return audited(
						"POST",
						path,
						{ metadataLength: item.base64EncodedMetadata.length },
						() =>
							withProviderCreateRefusal(() =>
								api.encoding.encodings.scte35Triggers.create(
									encodingId,
									new Scte35Trigger({
										base64EncodedMetadata: item.base64EncodedMetadata,
									}),
								),
							),
						(result) => ({ id: result.id }),
					).then(id);
				}
				case "BIF": {
					const body = new Bif({
						filename: item.filename,
						distance: item.distance,
						width: item.width,
						height: item.height,
						outputs: destination(),
					});
					const bif = encodings.streams.bifs;
					return createStamped({
						path: `${streamPath()}/bifs`,
						body,
						create: () =>
							api.encoding.encodings.streams.bifs.create(
								encodingId,
								streamId(),
								body,
							),
						list: (page) => bif.list(encodingId, streamId(), page),
						readIdentity: (resourceId) =>
							bif.customdata.get(encodingId, streamId(), resourceId),
					});
				}
				case "BURN_IN_ASSA": {
					const body = new BurnInSubtitleAssa({
						input: input(item.inputPath),
						characterEncoding: sdkEnumValue(
							CaptionCharacterEncoding,
							item.characterEncoding,
							"CaptionCharacterEncoding",
						),
					});
					const assa = encodings.streams.burnInSubtitles.assa;
					return createStamped({
						path: `${streamPath()}/burn-in-subtitles/assa`,
						body,
						create: () =>
							api.encoding.encodings.streams.burnInSubtitles.assa.create(
								encodingId,
								streamId(),
								body,
							),
						list: (page) => assa.list(encodingId, streamId(), page),
						readIdentity: (resourceId) =>
							assa.get(encodingId, streamId(), resourceId),
					});
				}
				case "BURN_IN_DVBSUB": {
					const body = new BurnInSubtitleDvbSub({
						inputStreamId: required(refs.inputStreamId, "DVB ingest"),
					});
					const dvbsub = encodings.streams.burnInSubtitles.dvbsub;
					return createStamped({
						path: `${streamPath()}/burn-in-subtitles/dvbsub`,
						body,
						create: () =>
							api.encoding.encodings.streams.burnInSubtitles.dvbsub.create(
								encodingId,
								streamId(),
								body,
							),
						list: (page) => dvbsub.list(encodingId, streamId(), page),
						readIdentity: (resourceId) =>
							dvbsub.get(encodingId, streamId(), resourceId),
					});
				}
				case "CEA_SCC": {
					const body = new SccCaption({
						input: input(item.inputPath),
						smpteTimecodeFlavor: optEnum(
							SmpteTimecodeFlavor,
							item.smpteTimecodeFlavor,
							"SmpteTimecodeFlavor",
						),
					});
					const scc = encodings.streams.captions.cea.scc;
					return createStamped({
						path: `${streamPath()}/captions/608-708/scc`,
						body,
						create: () =>
							api.encoding.encodings.streams.captions.cea.scc.create(
								encodingId,
								streamId(),
								body,
							),
						list: (page) => scc.list(encodingId, streamId(), page),
						readIdentity: (resourceId) =>
							scc.customdata.get(encodingId, streamId(), resourceId),
					});
				}
				case "CEA_SRT": {
					const body = new SrtToCea608708Caption({
						input: input(item.inputPath),
						ccChannel: Cea608ChannelType[item.ccChannel],
						characterEncoding: sdkEnumValue(
							CaptionCharacterEncoding,
							item.characterEncoding,
							"CaptionCharacterEncoding",
						),
					});
					const srt = encodings.streams.captions.cea.srt;
					return createStamped({
						path: `${streamPath()}/captions/608-708/srt`,
						body,
						create: () =>
							api.encoding.encodings.streams.captions.cea.srt.create(
								encodingId,
								streamId(),
								body,
							),
						list: (page) => srt.list(encodingId, streamId(), page),
						readIdentity: (resourceId) =>
							srt.customdata.get(encodingId, streamId(), resourceId),
					});
				}
				case "PSNR": {
					if (options.stamp?.adoptWindow?.())
						throw new Error(
							"Provider PSNR registration could not be verified after interruption",
						);
					await audited(
						"POST",
						`${streamPath()}/qc/psnr`,
						undefined,
						() =>
							withProviderCreateRefusal(() =>
								api.encoding.encodings.streams.qc.psnr.create(
									encodingId,
									streamId(),
								),
							),
						(result) => ({ id: result.id }),
					);
					return undefined;
				}
			}
		},
	};
}
