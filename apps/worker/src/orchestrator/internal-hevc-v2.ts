import { isDeepStrictEqual } from "node:util";
import {
	type CompiledOperation,
	compilePlan,
	downgradeJitManifests,
	type EncodingPlan,
	type InternalHevcV2,
	internalHevcV2Schema,
	isInternalHevcV2Account,
	type StepLogEntry,
} from "@bitovp/core";

export type { InternalHevcV2 } from "@bitovp/core";
/** Defense in depth for queued/retried work and direct SDK callers. */
export function assertInternalHevcV2Access(
	accountId: string | undefined,
	profile: InternalHevcV2,
): void {
	if (
		!isInternalHevcV2Account(
			accountId,
			process.env.BITOVP_INTERNAL_HEVC_V2_ACCOUNT_ID,
		) ||
		!internalHevcV2Schema.safeParse(profile).success
	) {
		throw new Error(
			"Internal HEVCv2 is not enabled for this account/deployment",
		);
	}
}

/** Accept only compiler order or the exact existing JIT downgrade transformation. */
export function internalHevcV2StepsMatch(
	plan: EncodingPlan,
	entries: readonly StepLogEntry[],
): boolean {
	const matches = (expected: readonly CompiledOperation[]) =>
		entries.length === expected.length &&
		entries.every((entry, index) => {
			const op = expected[index];
			return (
				op !== undefined &&
				entry.step === op.step &&
				entry.kind === op.kind &&
				isDeepStrictEqual(
					entry.payload,
					JSON.parse(JSON.stringify(op.payload)),
				) &&
				isDeepStrictEqual(entry.refs, op.refs)
			);
		});
	if (matches(compilePlan(plan))) return true;
	if (plan.generation.timing !== "POST_ENCODING") return false;
	// A persisted fallback keeps the already-created manifest resources in their
	// original positions; only START is rewritten and generation steps appended.
	const jit: EncodingPlan = {
		...plan,
		generation: { ...plan.generation, timing: "JUST_IN_TIME" },
	};
	const before = compilePlan(jit);
	const downgrade = downgradeJitManifests(
		jit,
		before.map((op) => op.step),
	);
	if (!downgrade.ok) return false;
	return matches([
		...before.map((op) => downgrade.rewritten.get(op.step) ?? op),
		...downgrade.appended,
	]);
}
