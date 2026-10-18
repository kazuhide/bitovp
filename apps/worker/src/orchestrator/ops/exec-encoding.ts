/**
 *  half 2: the encoding cases of executor.ts' 84-case switch,
 * moved VERBATIM. executor.ts keeps every case LABEL (grouped, so its
 * `never` default still proves exhaustiveness and the freeze scan still
 * reads all 84) and dispatches here; this switch narrows the same way the
 * monolithic one did. The default is unreachable by construction.
 */

import {
	assertSecretEgressAllowed,
	type CompiledOperation,
	capturePerTitleResults,
	type PerTitleCaptureOutcome,
	templateStreamRefSchema,
} from "@bitovp/core";
import type { StepResult } from "../executor";
import type { SdkOps } from "../sdk-ops";
import type { ExecStepContext } from "./exec-shared";
import {
	awaitTask,
	egressAllowlist,
	optInfrastructure,
	optNum,
	optStr,
	refId,
	refIdList,
	requireNum,
	str,
} from "./exec-shared";

export async function executeEncodingStep(
	op: CompiledOperation,
	ec: ExecStepContext,
): Promise<StepResult> {
	const { ctx, request, startedDuringCrashWindow } = ec;
	const p = op.payload;
	switch (op.kind) {
		case "CREATE_ENCODING": {
			const resourceId = await ctx.sdk.createEncoding({
				name: str(p.name),
				cloudRegion: str(p.cloudRegion),
				encoderVersion: str(p.encoderVersion),
				fallbackCloudRegions: Array.isArray(p.fallbackCloudRegions)
					? (p.fallbackCloudRegions as string[])
					: undefined,
				labels: Array.isArray(p.labels) ? (p.labels as string[]) : undefined,
				infrastructure: optInfrastructure(p.infrastructure),
				staticIpId: optStr(p.staticIpId),
			});
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_KANTAR_WATERMARK": {
			// Encoding-level singleton. The Kantar service login is vault
			// material (KANTAR provider); the plan carries only credentialId,
			// and neither half ever reaches a snapshot (sdk-ops substitutes
			// presence flags).
			const cred = await ctx.resolveCredential(str(p.credentialId));
			if (cred.provider !== "KANTAR") {
				throw new Error(
					`step "${op.step}" needs a KANTAR credential but got provider "${cred.provider}"`,
				);
			}
			const { login, password } = cred.secret;
			if (!login || !password) {
				// Never fall back to "" — blank service auth fails open.
				throw new Error(
					`step "${op.step}": KANTAR credential is missing its login/password pair`,
				);
			}
			assertSecretEgressAllowed(
				[
					{
						field: "kantar.serverUrl",
						url: str(p.serverUrl),
						carries: "the Kantar watermarking login and password",
					},
				],
				egressAllowlist(),
				(message) => {
					console.warn(`[egress] step "${op.step}": ${message}`);
				},
			);
			const resourceId = await ctx.sdk.createKantarWatermark(
				refId(op, ctx, "encodingId"),
				{
					login,
					password,
					// Never default to 0 (review catch m2): the wizard deliberately
					// leaves a blank licence undefined so zod rails it, and a
					// fabricated licence id would be billed against someone.
					licenseId: requireNum(op, "licenseId", p.licenseId),
					channelName: str(p.channelName),
					contentReference: str(p.contentReference),
					serverUrl: str(p.serverUrl),
					report: {
						outputId: refId(op, ctx, "reportOutputId"),
						outputPath: str(p.reportPath),
						acl: optStr(p.reportAcl),
					},
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_NEXGUARD_FILE_MARKER": {
			const cred = await ctx.resolveCredential(str(p.credentialId));
			if (cred.provider !== "NEXGUARD") {
				throw new Error(
					`step "${op.step}" needs a NEXGUARD credential but got provider "${cred.provider}"`,
				);
			}
			const license = cred.secret.license;
			if (!license) {
				// Never fall back to "" — an empty license must fail loud.
				throw new Error(
					`step "${op.step}": NEXGUARD credential carries no license`,
				);
			}
			const resourceId = await ctx.sdk.createNexGuardFileMarker(
				refId(op, ctx, "encodingId"),
				refId(op, ctx, "streamId"),
				{
					license,
					watermarkType: str(p.watermarkType),
					preset: optStr(p.preset),
					strength: optStr(p.strength),
					payload: optNum(p.payload),
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "START_ENCODING": {
			const encodingId = refId(op, ctx, "encodingId");
			const ai = p.aiSceneAnalysis as
				| {
						features?: {
							assetDescription?: {
								filename?: string;
								outputPath?: string;
								acl?: string;
							};
							automaticAdPlacement?: NonNullable<
								Parameters<SdkOps["startEncoding"]>[1]["aiSceneAnalysis"]
							>["automaticAdPlacement"];
							outputLanguageCodes?: { outputLanguageCodes?: string[] };
						};
				  }
				| undefined;
			let aiSceneAnalysis:
				| Parameters<SdkOps["startEncoding"]>[1]["aiSceneAnalysis"]
				| undefined;
			if (ai !== undefined) {
				const asset = ai.features?.assetDescription;
				if (!asset) {
					// Dropping the asset description would silently lose the
					// scenario's primary artifact (the AISA JSON).
					throw new Error(
						`step "${op.step}": aiSceneAnalysis payload carries no assetDescription`,
					);
				}
				aiSceneAnalysis = {
					assetDescription: {
						filename: str(asset.filename),
						outputId: refId(op, ctx, "aiAssetDescriptionOutputId"),
						outputPath: str(asset.outputPath),
						acl: optStr(asset.acl),
					},
					automaticAdPlacement: ai.features?.automaticAdPlacement,
					outputLanguageCodes:
						ai.features?.outputLanguageCodes?.outputLanguageCodes,
				};
			}
			const already = await startedDuringCrashWindow(() =>
				ctx.sdk.getEncodingStatus(encodingId),
			);
			if (already) {
				return {
					request,
					response: { started: true, resumed: true, status: already.status },
				};
			}
			await ctx.sdk.startEncoding(encodingId, {
				manifestGenerator: optStr(p.manifestGenerator),
				vodHlsManifestIds: refIdList(op, ctx, "vodHlsManifestIds"),
				vodDashManifestIds: refIdList(op, ctx, "vodDashManifestIds"),
				vodSmoothManifestIds: refIdList(op, ctx, "vodSmoothManifestIds"),
				previewHlsManifestIds: refIdList(op, ctx, "previewHlsManifestIds"),
				previewDashManifestIds: refIdList(op, ctx, "previewDashManifestIds"),
				perTitle: p.perTitle as Record<string, unknown> | undefined,
				encodingMode: optStr(p.encodingMode),
				audioVideoSyncMode: optStr(
					(p.tweaks as { audioVideoSyncMode?: unknown } | undefined)
						?.audioVideoSyncMode,
				),
				handleVariableInputFps:
					typeof p.handleVariableInputFps === "boolean"
						? p.handleVariableInputFps
						: undefined,
				aiSceneAnalysis,
				scheduling: p.scheduling as
					| { priority?: number; prewarmedEncoderPoolIds?: string[] }
					| undefined,
			});
			return { request, response: { started: true } };
		}

		case "AWAIT_ENCODING": {
			const encodingId = refId(op, ctx, "encodingId");
			const task = await awaitTask(op, ctx, () =>
				ctx.sdk.getEncodingStatus(encodingId),
			);
			return { request, response: task };
		}

		case "CAPTURE_PER_TITLE_RESULTS": {
			const encodingId = refId(op, ctx, "encodingId");
			// BEST EFFORT BY DESIGN . The encode has already succeeded by the
			// time this runs; the snapshot is enrichment. There is no WARN step
			// status, so the outcome rides the response and the step lands DONE
			// either way — a capture failure must be VISIBLE (the UI says the
			// results could not be read) and must never fail a good encode or
			// render as an empty results table.
			try {
				const snapshot = await capturePerTitleResults(
					{
						listStreams: (id) => ctx.sdk.listEncodingStreams(id),
						listMuxings: (id) => ctx.sdk.listAllMuxings(id),
						getCodecConfig: (id) => ctx.sdk.getCodecConfigDetail(id),
					},
					{
						encodingId,
						capturedAt: new Date().toISOString(),
						// Plan knowledge, compiled into the payload — the executor is
						// plan-free by design. Parsed, not trusted: a hand-edited step
						// log cannot make attribution read arbitrary shapes.
						templates: templateStreamRefSchema
							.array()
							.catch([])
							.parse(op.payload.templates),
					},
				);
				const outcome: PerTitleCaptureOutcome = { captured: true, snapshot };
				return { request, response: outcome };
			} catch (err) {
				const outcome: PerTitleCaptureOutcome = {
					captured: false,
					error: err instanceof Error ? err.message : String(err),
				};
				return { request, response: outcome };
			}
		}
		default:
			throw new Error(
				`executeEncodingStep: unhandled kind ${String(op.kind)} — the executor dispatch and this switch have diverged`,
			);
	}
}
