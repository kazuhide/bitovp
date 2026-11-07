import "server-only";
import { isAisaManagedLivePlan } from "@bitovp/core";
import { jsonError } from "./http";

/** The AISA service owns this graph; ordinary runtime mutations cannot address it. */
export function rejectAisaGraphMutation(channel: {
	origin?: string;
	plan?: unknown;
}) {
	if (channel.origin === "AISA_IMPORTED")
		return jsonError(409, "Imported AISA runs are read-only", {
			code: "AISA_IMPORTED_READ_ONLY",
		});
	if (isAisaManagedLivePlan(channel.plan))
		return jsonError(
			409,
			"This operation is unavailable for AISA Live Preview",
			{ code: "AISA_ACTION_UNSUPPORTED" },
		);
	return null;
}
