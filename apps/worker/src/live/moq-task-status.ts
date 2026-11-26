import { projectMoqTaskStatus } from "@bitovp/core";
import type { SdkOps } from "../orchestrator/sdk-ops";

/** Apply only to the SDK owned by a stored CREATE_OUTPUT_MOQ run. */
export function withMoqTaskStatus(sdk: SdkOps): SdkOps {
	return {
		...sdk,
		getEncodingStatus: async (encodingId) => {
			try {
				const task = projectMoqTaskStatus(
					await sdk.getEncodingStatus(encodingId),
				);
				if (task) return task;
			} catch {
				// SDK errors can echo provider Task text; neither prose nor cause escapes.
			}
			throw new Error("MoQ encoding status unavailable");
		},
	};
}
