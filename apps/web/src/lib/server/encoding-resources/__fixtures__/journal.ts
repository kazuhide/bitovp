import { protectedManifestFixture } from "./protected-manifest";
import { randomUUID } from "node:crypto";
import type { OperationKind, StepLogEntry } from "@bitovp/core";
import type contracts from "./sdk-contracts.json";
const parentKinds: Record<string, OperationKind> = {
	encodingId: "CREATE_ENCODING",
	streamId: "CREATE_STREAM",
	periodId: "CREATE_DASH_PERIOD",
	adaptationSetId: "CREATE_DASH_ADAPTATION_SET_VIDEO",
	mediaId: "CREATE_HLS_AUDIO_MEDIA",
	streamInfoId: "CREATE_HLS_STREAM_INFO",
};
function supplementFixture(kind: string) {
	const key = "test";
	const stream = { renditionKey: "video" };
	const destination = { outputKey: "extras", path: "delivery/" };
	const input = (name: string) => ({ inputKey: "main", inputPath: name });
	switch (kind) {
		case "SCC_CONVERSION": return { kind, key, ...input("captions.scc"), filename: "captions.vtt", destination };
		case "SIDECAR":
		case "WEBVTT_SIDECAR": return { kind, key, ...input("captions.vtt"), destination };
		case "SCTE35_TRIGGER": return { kind, key, base64EncodedMetadata: "AAEC" };
		case "BIF": return { kind, key, ...stream, width: 320, distance: 10, filename: "previews.bif", destination };
		case "BURN_IN_ASSA": return { kind, key, ...stream, ...input("captions.ass"), characterEncoding: "UTF_8" };
		case "BURN_IN_DVBSUB": return { kind, key, ...stream, ingestKey: "subs" };
		case "CEA_SCC": return { kind, key, ...stream, ...input("captions.scc") };
		case "CEA_SRT": return { kind, key, ...stream, ...input("captions.srt"), characterEncoding: "UTF_8", ccChannel: "CC1" };
		default: throw new Error("Unknown supplement fixture");
	}
}

export function resourceFixture(
	contract: (typeof contracts)[number],
	accountId: string,
	version: string,
) {
	if (contract.protectedVariant)
		return protectedManifestFixture(contract, accountId, version);
	const id: string = randomUUID();
	const refs: Record<string, string> = {},
		requestRefs: Record<string, string> = {},
		steps: StepLogEntry[] = [];
	let expected = contract.detail;
	for (const [param, ref] of Object.entries(contract.parents)) {
		if (!ref) throw new Error("Missing fixture parent");
		const parent = randomUUID(),
			step = `source:${ref}`;
		let kind = parentKinds[ref];
		if (ref === "muxingId" && contract.muxingKind)
			kind = `CREATE_MUXING_${contract.muxingKind}` as OperationKind;
		if (ref === "manifestId")
			kind = contract.detail.includes("/dash/")
				? "CREATE_MANIFEST_DASH"
				: contract.detail.includes("/hls/")
					? "CREATE_MANIFEST_HLS"
					: "CREATE_MANIFEST_SMOOTH";
		if (!kind) throw new Error("Unknown fixture parent");
		steps.push({
			step,
			kind,
			payload: {},
			refs: { ...refs },
			request: { refs: { ...requestRefs } },
			status: "DONE",
			resourceId: parent,
		});
		expected = expected.replace(`{${param}}`, parent);
		refs[ref] = step;
		requestRefs[ref] = parent;
	}
	expected = expected.replace(/\{[^}]+\}$/, id);
	steps.push({
		step: "selected",
		kind: contract.kind as OperationKind,
		payload: {
			...(contract.muxingKind ? { muxingKind: contract.muxingKind } : {}),
			...(contract.drmKind ? { drmKind: contract.drmKind } : {}),
			...(contract.format ? { format: contract.format } : {}),
			...(contract.hevcV2 ? { internalHevcV2: true } : {}),
			...(contract.supplementKind ? { supplement: supplementFixture(contract.supplementKind) } : {}),
			...(contract.tagTarget ? { target: contract.tagTarget } : {}),
		},
		refs,
		request: { refs: requestRefs },
		status: "DONE",
		resourceId: id,
		response: { id },
		resourceAccount: { id: accountId, version },
	});
	return { id, steps, expected: `/v1${expected}` };
}
