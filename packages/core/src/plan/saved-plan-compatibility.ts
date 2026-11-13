import { encodingPlanSchema } from "./schema";
import { checkDeliveryCommitment } from "./submit";
import { validatePlan } from "./validate";

export type SavedPlanCompatibility = {
	blocking: boolean;
	issues: { code: string; level: "error" | "warning"; path?: string }[];
	action:
		| "OPEN_TEMPLATE_AND_RESAVE"
		| "RELOAD_DELIVERY_PRESET_AND_RESAVE"
		| null;
};

/** Read-only upgrade check. Locations, names and plan values never enter the report.
 * This checks plan structure and current delivery commitments, not provider access
 * or deployment-dependent capabilities. Submission remains the final authority.
 */
export function inspectSavedPlanCompatibility(
	raw: unknown,
): SavedPlanCompatibility {
	const parsed = encodingPlanSchema.safeParse(raw);
	if (!parsed.success)
		return {
			blocking: true,
			issues: [{ code: "PLAN_PARSE", level: "error" }],
			action: "OPEN_TEMPLATE_AND_RESAVE",
		};
	const verdict = checkDeliveryCommitment(parsed.data);
	const issues = [
		...validatePlan(parsed.data),
		...(verdict.refusal?.issues ?? verdict.warnings ?? []),
	].map(({ code, level, path }) => ({
		code,
		level,
		...(path ? { path } : {}),
	}));
	return {
		blocking: issues.some((issue) => issue.level === "error"),
		issues,
		action: issues.length
			? issues.some((issue) => issue.code === "PLAN_DELIVERY_DEVIATION")
				? "RELOAD_DELIVERY_PRESET_AND_RESAVE"
				: "OPEN_TEMPLATE_AND_RESAVE"
			: null,
	};
}
