import { aesKeyFileUriSchema, type CompiledOperation } from "@bitovp/core";
import type { StepResult } from "../executor";
import {
	destinationOf,
	type ExecStepContext,
	num,
	optNum,
	optStr,
	refId,
	refIdList,
	str,
} from "./exec-shared";

export async function executeNativePackagingStep(
	op: CompiledOperation,
	{ ctx, request }: ExecStepContext,
): Promise<StepResult> {
	const p = op.payload;
	const apply = async () => {
		switch (op.kind) {
			case "CREATE_CODEC_MP3":
			case "CREATE_CODEC_H262":
				return ctx.sdk.createNativeDeliveryCodec({
					kind: op.kind === "CREATE_CODEC_H262" ? "H262" : "MP3",
					name: optStr(p.name),
					bitrate: num(p.bitrate, 0),
					rate: optNum(p.rate),
					width: optNum(p.width),
					height: optNum(p.height),
					profile: optStr(p.profile),
				});
			case "CREATE_MUXING_BROADCAST_TS":
			case "CREATE_MUXING_MP3":
			case "CREATE_MUXING_MXF":
			case "CREATE_MUXING_PACKED_AUDIO":
			case "CREATE_MUXING_SEGMENTED_RAW":
				return ctx.sdk.createNativeMuxing(refId(op, ctx, "encodingId"), {
					kind: op.kind.slice("CREATE_MUXING_".length),
					streamId: refId(op, ctx, "streamId"),
					additionalStreamIds: refIdList(op, ctx, "additionalStreamIds"),
					destination: destinationOf(op, ctx),
					name: optStr(p.name),
					filename: optStr(p.filename),
					segmentLength: optNum(p.segmentLength),
					segmentNaming: optStr(p.segmentNaming),
				});
			case "CREATE_DRM_TYPED": {
				const keyFileUri =
					p.drmKind === "AES"
						? aesKeyFileUriSchema.parse(p.keyFileUri)
						: undefined;
				const credential = await ctx.resolveCredential(str(p.credentialId));
				const key = credential.secret.key;
				if (
					credential.provider !== "DRM_CENC" ||
					!key ||
					!/^[a-f0-9]{32}$/i.test(key) ||
					key.toLowerCase() === optStr(p.kid)?.toLowerCase()
				)
					throw new Error(
						"A valid vaulted DRM key distinct from its key ID is required",
					);
				const destination = destinationOf(op, ctx);
				if (!destination)
					throw new Error("A DRM output destination is required");
				return ctx.sdk.createTypedMuxingDrm(
					refId(op, ctx, "encodingId"),
					refId(op, ctx, "muxingId"),
					{
						muxingKind: str(p.muxingKind),
						kind: str(p.drmKind),
						destination,
						name: optStr(p.name),
						key,
						kid: optStr(p.kid),
						pssh: optStr(p.pssh),
						iv: optStr(p.iv),
						keyFileUri,
						method: optStr(p.method),
					},
				);
			}
			case "CREATE_PROGRESSIVE_TS_ID3":
				return ctx.sdk.createProgressiveTsId3(
					refId(op, ctx, "encodingId"),
					refId(op, ctx, "muxingId"),
					{
						format: str(p.format),
						positionMode: str(p.positionMode),
						time: optNum(p.time),
						frame: optNum(p.frame),
						frameId: optStr(p.frameId),
						bytes: optStr(p.bytes),
						text: optStr(p.text),
					},
				);
			default:
				throw new Error("Unsupported packaging operation");
		}
	};
	const resourceId = await apply();
	return { resourceId, request, response: { id: resourceId } };
}
