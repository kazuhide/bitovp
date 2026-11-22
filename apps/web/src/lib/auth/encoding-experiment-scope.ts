import { experimentScope as ENCODING_EXPERIMENT_SCOPE } from "@bitovp/core/encoding-experiments";
import { isSelfTokenRevocation } from "./roles";

export const EXPERIMENT_API_PATH = "/api/encoding-experiments/v1";
export { ENCODING_EXPERIMENT_SCOPE };

type ScopeContext = {
	actor: string;
	tokenScope?: string | null;
	tokenRoleKnown?: boolean;
};

export function experimentScopeRefusal(
	context: ScopeContext,
	path: string,
	method: string,
	mode: string,
): "EXPERIMENT_AUTH_REQUIRED" | "TOKEN_SCOPE_DENIED" | null {
	const isExperiment =
		path === EXPERIMENT_API_PATH || path.startsWith(`${EXPERIMENT_API_PATH}/`);
	if (isExperiment && mode === "none") return "EXPERIMENT_AUTH_REQUIRED";
	if (!context.actor.startsWith("token:")) return null;
	if (isExperiment)
		return context.tokenScope === ENCODING_EXPERIMENT_SCOPE &&
			context.tokenRoleKnown === true
			? null
			: "TOKEN_SCOPE_DENIED";
	if (
		context.tokenScope != null &&
		!isSelfTokenRevocation(context.actor.slice(6), path, method)
	)
		return "TOKEN_SCOPE_DENIED";
	return null;
}
