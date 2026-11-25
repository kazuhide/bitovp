import { z } from "zod";

export const conditionTreeLimits = {
	nodes: 128,
	depth: 8,
	children: 32,
} as const;

/** Bound recursive parsing before Zod descends into untrusted request data. */
export function boundedConditionTree<T>(node: z.ZodType<T>, subject: string) {
	return z.preprocess((value, ctx) => {
		const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
		let nodes = 0;
		while (pending.length) {
			const next = pending.pop();
			if (!next) break;
			if (
				++nodes > conditionTreeLimits.nodes ||
				next.depth > conditionTreeLimits.depth
			) {
				ctx.addIssue({
					code: "custom",
					message: `${subject} support at most 128 nodes and 8 nested groups`,
				});
				return z.NEVER;
			}
			if (
				next.value &&
				typeof next.value === "object" &&
				"conditions" in next.value &&
				Array.isArray(next.value.conditions)
			) {
				if (next.value.conditions.length > conditionTreeLimits.children) {
					ctx.addIssue({
						code: "custom",
						message: "Each condition group supports at most 32 conditions",
					});
					return z.NEVER;
				}
				for (const child of next.value.conditions)
					pending.push({ value: child, depth: next.depth + 1 });
			}
		}
		return value;
	}, node);
}
