import { protectedManifestFixture } from "./protected-manifest";
import { randomUUID } from "node:crypto";
import type { OperationKind, StepLogEntry } from "@bitovp/core";
import type contracts from "./sdk-contracts.json";
const parentKinds: Record<string, OperationKind> = {
	encodingId: "CREATE_ENCODING",
	streamId: "CREATE_STREAM",
	periodId: "CREATE_DASH_PERIOD",
	adaptationSetId: "CREATE_DASH_ADAPTATION_SET_VIDEO",
	streamInfoId: "CREATE_HLS_STREAM_INFO",
};
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
			...(contract.hevcV2 ? { internalHevcV2: true } : {}),
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
