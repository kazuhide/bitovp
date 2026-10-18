/**
 *  half 2: the live cases of executor.ts' 84-case switch,
 * moved VERBATIM. executor.ts keeps every case LABEL (grouped, so its
 * `never` default still proves exhaustiveness and the freeze scan still
 * reads all 84) and dispatches here; this switch narrows the same way the
 * monolithic one did. The default is unreachable by construction.
 */

import {
	assertSecretEgressAllowed,
	type CompiledOperation,
	isRuntimeRecordKind,
} from "@bitovp/core";
import type { StepResult } from "../executor";
import type {
	LiveDashStartOptions,
	LiveHlsStartOptions,
	SdkOps,
} from "../sdk-ops";
import type { ExecStepContext } from "./exec-shared";
import {
	awaitLiveRunning,
	CancelRequested,
	diagnoseLiveStartFailure,
	egressAllowlist,
	optNum,
	optStr,
	refId,
	str,
	zipLiveManifests,
} from "./exec-shared";

export async function executeLiveStep(
	op: CompiledOperation,
	ec: ExecStepContext,
): Promise<StepResult> {
	const { ctx, request, startedDuringCrashWindow } = ec;
	const p = op.payload;
	// Runtime records are post-provisioning entries written by whoever fired the
	// signal, never executable steps — the replay loop skips them by KIND, which
	// is what makes this reachable only through a mistake. (It used to say "the
	// replay only calls executeStep on non-DONE entries"; that was already the
	// wrong mechanism — the kind check comes first — and  made it
	// wrong on the facts too, since a slate's records are now RUNNING and
	// FAILED.) Reaching here means such an entry was mis-seeded; fail loudly
	// rather than re-firing signalling into a live stream.
	//
	// Derived, not restated: this used to be three hand-written `case` labels, and
	// the SET they were supposed to mirror was short one member for its whole life
	// (see RUNTIME_RECORD_KINDS). One list, read from one place.
	if (isRuntimeRecordKind(op.kind)) {
		throw new Error(`${op.kind} is a runtime record, not an executable step`);
	}
	switch (op.kind) {
		case "CREATE_INPUT_HLS_LIVE": {
			const resourceId = await ctx.sdk.createHlsLiveInput({
				name: str(p.name),
				url: optStr(p.url),
				adMarkersSource: optStr(p.adMarkersSource),
			});
			return { resourceId, request, response: { id: resourceId } };
		}

		case "START_LIVE_ENCODING": {
			const encodingId = refId(op, ctx, "encodingId");
			// Same crash-window contract as VOD starts: re-starting an
			// already-started live encoding 400s forever and wedges the
			// channel. FINISHED counts as started too — it means the channel
			// stopped after a successful start; restart is an explicit action.
			const already = await startedDuringCrashWindow(() =>
				ctx.sdk.getEncodingStatus(encodingId),
			);
			if (already) {
				return {
					request,
					response: { started: true, resumed: true, status: already.status },
				};
			}
			// ESAM POIS basic auth resolves HERE, at execution only — the
			// payload/step-log carry poisCredentialId, never the pair (the
			// SRT-passphrase precedent, DRM gates S1–S5).
			const esamPayload = p.esamSettings as
				| {
						poisEndpoint?: unknown;
						acquisitionPointIdentity?: unknown;
						zoneIdentity?: unknown;
						adAvailOffset?: unknown;
						poisCredentialId?: unknown;
				  }
				| undefined;
			let esamSettings:
				| Parameters<SdkOps["startLiveEncoding"]>[1]["esamSettings"]
				| undefined;
			if (esamPayload) {
				let username: string | undefined;
				let password: string | undefined;
				if (esamPayload.poisCredentialId !== undefined) {
					const cred = await ctx.resolveCredential(
						str(esamPayload.poisCredentialId),
					);
					if (cred.provider !== "POIS_ENDPOINT") {
						throw new Error(
							`step "${op.step}" needs a POIS_ENDPOINT credential but got provider "${cred.provider}"`,
						);
					}
					username = cred.secret.username;
					password = cred.secret.password;
					if (!username || !password) {
						// Never fall back to "" — blank basic auth fails open.
						throw new Error(
							`step "${op.step}": POIS_ENDPOINT credential is missing its username/password pair`,
						);
					}
				}
				// Only when a credential rides: without the pair there is nothing
				// secret to egress, and blocking a plain (unauthenticated) POIS
				// endpoint would rail a case the constraint does not cover.
				if (username !== undefined) {
					assertSecretEgressAllowed(
						[
							{
								field: "start.esam.poisEndpoint",
								url: optStr(esamPayload.poisEndpoint) ?? "",
								carries: "the ESAM POIS username and password",
							},
						],
						egressAllowlist(),
						(message) => {
							console.warn(`[egress] step "${op.step}": ${message}`);
						},
					);
				}
				esamSettings = {
					poisEndpoint: optStr(esamPayload.poisEndpoint),
					acquisitionPointIdentity: optStr(
						esamPayload.acquisitionPointIdentity,
					),
					zoneIdentity: optStr(esamPayload.zoneIdentity),
					adAvailOffset: optNum(esamPayload.adAvailOffset),
					username,
					password,
				};
			}
			try {
				if (ctx.shouldCancel && (await ctx.shouldCancel()))
					throw new CancelRequested(op.step, true);
				await ctx.sdk.startLiveEncoding(encodingId, {
					...(p.encodingOption !== undefined
						? { encodingOption: p.encodingOption as "HD" | "CUSTOM" }
						: {}),
					streamKey: str(p.streamKey),
					hlsManifests: zipLiveManifests(
						op,
						ctx,
						"liveHlsManifestIds",
						p.hlsManifests as Record<string, LiveHlsStartOptions> | undefined,
					),
					dashManifests: zipLiveManifests(
						op,
						ctx,
						"liveDashManifestIds",
						p.dashManifests as Record<string, LiveDashStartOptions> | undefined,
					),
					liveEncodingMode: optStr(p.liveEncodingMode),
					reuploadSettings: p.reuploadSettings as
						| {
								dashManifestInterval?: number | null;
								muxingInitFileInterval?: number | null;
						  }
						| undefined,
					manifestGenerator: optStr(p.manifestGenerator),
					// Compiler-validated shapes (schema-parsed plan) — passthrough.
					autoRestartConfiguration: p.autoRestartConfiguration as Parameters<
						SdkOps["startLiveEncoding"]
					>[1]["autoRestartConfiguration"],
					autoShutdownConfiguration: p.autoShutdownConfiguration as Parameters<
						SdkOps["startLiveEncoding"]
					>[1]["autoShutdownConfiguration"],
					esamSettings,
					cacheControlSettings: p.cacheControlSettings as Parameters<
						SdkOps["startLiveEncoding"]
					>[1]["cacheControlSettings"],
					adInsertionSettings: p.adInsertionSettings as Parameters<
						SdkOps["startLiveEncoding"]
					>[1]["adInsertionSettings"],
				});
			} catch (err) {
				// Turn an opaque "input not found" (2025) into a diagnosis: the
				// inputId baked into the encoding's ingest streams vs. what the
				// account resolves now vs. what this run resolved.
				throw await diagnoseLiveStartFailure(err, ctx, encodingId);
			}
			return { request, response: { started: true } };
		}

		case "AWAIT_LIVE_RUNNING": {
			const encodingId = refId(op, ctx, "encodingId");
			const task = await awaitLiveRunning(
				op,
				ctx,
				() => ctx.sdk.getEncodingStatus(encodingId),
				encodingId,
			);
			return { request, response: task };
		}

		default:
			/**
			 * NOT a `never` exhaustiveness check, and review-298's Suggestion 1
			 * to make it one does not hold in situ: `executeLiveStep` takes a
			 * `CompiledOperation`, whose `kind` is the FULL OperationKind union,
			 * and this switch deliberately handles only the live subset. Some
			 * eighty VOD kinds legitimately remain here, so `const x: never =
			 * op.kind` cannot compile (tsc says so — TS2322, tried). The header's
			 * "unreachable by construction" rests on executor.ts's dispatch,
			 * which the type system cannot see from here; executor.ts keeps the
			 * `never` that does prove it.
			 */
			throw new Error(
				`executeLiveStep: unhandled kind ${String(op.kind)} — the executor dispatch and this switch have diverged`,
			);
	}
}
