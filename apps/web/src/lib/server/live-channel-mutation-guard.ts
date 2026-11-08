import "server-only";
import { isAisaManagedLivePlan } from "@bitovp/core";
import { jsonError } from "./http";

/** Imported terminal runs are history, never an editable live channel. */
export function rejectImportedAisaMutation(channel: { origin?: string }) {
	if (channel.origin === "AISA_IMPORTED")
		return jsonError(409, "Imported AISA runs are read-only", {
			code: "AISA_IMPORTED_READ_ONLY",
		});
	return null;
}

/** Current managed integration does not retain the ordinary authored graph. */
export function rejectAisaGraphMutation(channel: {
	origin?: string;
	plan?: unknown;
}) {
	const imported = rejectImportedAisaMutation(channel);
	if (imported) return imported;
	if (isAisaManagedLivePlan(channel.plan))
		return jsonError(
			409,
			"This operation is unavailable for AISA Live Preview",
			{ code: "AISA_ACTION_UNSUPPORTED" },
		);
	return null;
}
