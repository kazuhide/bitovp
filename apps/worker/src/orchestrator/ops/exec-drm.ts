/**
 *  half 2: the drm cases of executor.ts' 84-case switch,
 * moved VERBATIM. executor.ts keeps every case LABEL (grouped, so its
 * `never` default still proves exhaustiveness and the freeze scan still
 * reads all 84) and dispatches here; this switch narrows the same way the
 * monolithic one did. The default is unreachable by construction.
 */
import {
	assertSecretEgressAllowed,
	type CompiledOperation,
	CREDENTIAL_PROVIDER_SHAPES,
} from "@bitovp/core";
import type { StepResult } from "../executor";
import type { ExecStepContext } from "./exec-shared";
import {
	destinationOf,
	egressAllowlist,
	optStr,
	refId,
	str,
} from "./exec-shared";

export async function executeDrmStep(
	op: CompiledOperation,
	ec: ExecStepContext,
): Promise<StepResult> {
	const { ctx, request } = ec;
	const p = op.payload;
	switch (op.kind) {
		case "CREATE_DRM_CENC": {
			const cred = await ctx.resolveCredential(str(p.credentialId));
			if (cred.provider !== "DRM_CENC") {
				throw new Error(
					`step "${op.step}" needs a DRM_CENC credential but got provider "${cred.provider}"`,
				);
			}
			const key = cred.secret.key;
			if (!key) {
				// Never fall back to "" — an empty content key fails open.
				throw new Error(
					`step "${op.step}": DRM_CENC credential carries no content key`,
				);
			}
			const kid = str(p.kid);
			if (kid && key === kid) {
				throw new Error(
					`step "${op.step}": content key must not equal kid (paste error)`,
				);
			}
			const resourceId = await ctx.sdk.createCencDrm(
				refId(op, ctx, "encodingId"),
				refId(op, ctx, "muxingId"),
				{
					muxingKind: str(p.muxingKind),
					key,
					kid,
					encryptionMode: optStr(p.encryptionMode),
					ivSize: optStr(p.ivSize),
					widevine: p.widevine as { pssh?: string } | undefined,
					playReady: p.playReady as
						| { laUrl?: string; pssh?: string }
						| undefined,
					fairPlay: p.fairPlay as { iv?: string; uri?: string } | undefined,
					destination: destinationOf(op, ctx),
					name: optStr(p.name),
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}

		case "CREATE_DRM_SPEKE": {
			const cred = await ctx.resolveCredential(str(p.credentialId));
			if (cred.provider !== "DRM_SPEKE")
				throw new Error(`step "${op.step}" needs a DRM_SPEKE credential`);
			const parsed = CREDENTIAL_PROVIDER_SHAPES.DRM_SPEKE.secret.safeParse(
				cred.secret,
			);
			if (!parsed.success)
				throw new Error(
					`step "${op.step}": SPEKE provider credential is incomplete or invalid`,
				);
			const provider = parsed.data;
			assertSecretEgressAllowed(
				[
					{
						field: "speke.provider.url",
						url: provider.url,
						carries: "SPEKE key-provider authentication",
					},
				],
				egressAllowlist(),
				() => {},
			);
			const resourceId = await ctx.sdk.createSpekeDrm(
				refId(op, ctx, "encodingId"),
				refId(op, ctx, "muxingId"),
				{
					muxingKind: str(p.muxingKind),
					provider,
					contentId: optStr(p.contentId),
					kid: optStr(p.kid),
					iv: optStr(p.iv),
					systemIds: p.systemIds as string[],
					destination: destinationOf(op, ctx),
					name: optStr(p.name),
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}
		case "CREATE_DRM_FAIRPLAY": {
			const cred = await ctx.resolveCredential(str(p.credentialId));
			if (cred.provider !== "DRM_CENC") {
				throw new Error(
					`step "${op.step}" needs a DRM_CENC credential but got provider "${cred.provider}"`,
				);
			}
			const key = cred.secret.key;
			if (!key) {
				// Never fall back to "" — an empty content key fails open.
				throw new Error(
					`step "${op.step}": DRM_CENC credential carries no content key`,
				);
			}
			const kid = str(p.kid);
			if (kid && key === kid) {
				throw new Error(
					`step "${op.step}": content key must not equal kid (paste error)`,
				);
			}
			const resourceId = await ctx.sdk.createFairPlayDrm(
				refId(op, ctx, "encodingId"),
				refId(op, ctx, "muxingId"),
				{
					muxingKind: str(p.muxingKind),
					key,
					// iv/uri are public manifest material from the plan.
					iv: str(p.iv),
					uri: str(p.uri),
					destination: destinationOf(op, ctx),
					name: optStr(p.name),
				},
			);
			return { resourceId, request, response: { id: resourceId } };
		}
		default:
			throw new Error(
				`executeDrmStep: unhandled kind ${String(op.kind)} — the executor dispatch and this switch have diverged`,
			);
	}
}
