import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	compilePlan,
	encodingPlanSchema,
	validatePlan,
	type StepLogEntry,
} from "@bitovp/core";
import { serverPlanValidationOptions } from "../../plan-validation";
import type contracts from "./sdk-contracts.json";

function loadPlan(name: string) {
	const file = resolve(
		import.meta.dirname,
		"../../../../../../../packages/core/src/plan/__fixtures__",
		name + ".plan.json",
	);
	return encodingPlanSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}
// Use the real compiler. The DASH manifest tree and its source encryption tree have independent roots.
export function protectedManifestFixture(
	contract: (typeof contracts)[number],
	account: string,
	version: string,
) {
	const mode = contract.protectedVariant;
	const plan = loadPlan(
		mode === "webm"
			? "vp9-webm-fixed-dash"
			: mode === "mp4-rep"
				? "dolby-dv-3ladder-profile5-dash-ondemand"
				: mode === "smooth"
					? "pertitle-h264-mp4-smooth-drm-on-aws"
					: "cenc-cbc-drm-on-aws",
	);
	const dash = plan.manifests.find((m) => m.kind === "DASH");
	if (dash?.kind === "DASH" && (mode === "webm" || mode === "mp4-rep")) {
		plan.drm = plan.muxings.map((m) => {
			if (!m.destination) throw new Error("Expected a fixture output");
			return {
				key: m.key + "-cenc",
				kind: "CENC",
				muxingKey: m.key,
				credentialId: "00000000-0000-4000-8000-000000000005",
				kid: "43214321432143214321432143214321",
				widevine: { pssh: "AAAA" },
				encryptionMode: "CTR",
				destination: {
					...m.destination,
					path: m.destination.path + "encrypted/",
				},
			};
		});
		dash.drmKind = "CENC";
	}
	if (
		dash?.kind === "DASH" &&
		(mode === "fmp4-rep" || mode === "fmp4-drm" || mode === "adaptation")
	) {
		const mux = plan.muxings[0];
		if (!mux) throw new Error("Missing fixture muxing");
		dash.detailed = {
			representations: [
				{
					muxingKey: mux.key,
					drmRepresentation: true,
					contentProtection:
						mode === "adaptation" ? "ADAPTATION_SET" : "REPRESENTATION",
				},
			],
		};
	}
	const issues = validatePlan(plan, serverPlanValidationOptions()).filter((x) => x.level === "error");
	if (issues.length) throw new Error(issues.map((e) => e.code).join(","));
	const ops = compilePlan(plan).filter((o) => o.kind.startsWith("CREATE_"));
	const target = ops.find(
		(o) =>
			o.kind === contract.kind &&
			o.refs.drmId &&
			(mode === "adaptation"
				? o.payload.representationKind === "ADAPTATION_SET"
				: mode === "fmp4-drm"
					? o.payload.representationKind === "FMP4_DRM"
					: mode === "webm"
						? o.payload.representationKind === "WEBM"
						: true),
	);
	if (!target) throw new Error("No compiled protected manifest step");
	const ids = new Map(ops.map((o) => [o.step, randomUUID()]));
	const id = ids.get(target.step);
	if (!id) throw new Error("No recorded target");
	const resolveRef = (r: string) => ids.get(r) ?? r;
	const steps: StepLogEntry[] = ops.map((o) => ({
		...o,
		step: o.step === target.step ? "selected" : o.step,
		status: "DONE",
		resourceId: ids.get(o.step),
		request: {
			...o.payload,
			refs: Object.fromEntries(
				Object.entries(o.refs).map(([k, v]) => [
					k,
					Array.isArray(v) ? v.map(resolveRef) : resolveRef(v),
				]),
			),
		},
		resourceAccount: { id: account, version },
		response: { id: ids.get(o.step) },
	}));
	let expected = contract.detail;
	for (const [param, ref] of Object.entries(contract.parents)) {
		const parent = ref && target.refs[ref];
		if (typeof parent !== "string" || !ids.has(parent))
			throw new Error("Missing actual wire parent " + param);
		expected = expected.replace("{" + param + "}", resolveRef(parent));
	}
	return { steps, id, expected: "/v1" + expected.replace(/\{[^}]+\}$/, id) };
}
