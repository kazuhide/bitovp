import { createHash } from "node:crypto";
import { canonicalEditingJson } from "../content-editing/automatic-binding";
import {
	LOCAL_ASR_ENGINE_VERSION,
	type MediaTaskCreateInput,
	type MediaTaskIdentity,
} from "./schema";

const hash = (value: unknown) =>
	createHash("sha256").update(canonicalEditingJson(value)).digest("hex");
export function mediaTaskIntentHash(
	input: MediaTaskCreateInput,
	parentTaskId: string | null = null,
) {
	const { requestKey: _requestKey, ...intent } = input;
	return hash({ version: "media-task-intent-v1", ...intent, parentTaskId });
}
export function mediaTaskCacheKey(
	input: MediaTaskCreateInput,
	identity: Omit<MediaTaskIdentity, "bindingSnapshot">,
) {
	const { requestKey: _requestKey, ...intent } = input;
	return hash({
		version: "local-production-v1",
		asrEngineVersion: LOCAL_ASR_ENGINE_VERSION,
		trackerVersion: identity.trackingAlgorithmVersion ?? "template-ncc-v1",
		...intent,
		identity: { ...identity, bindingHash: identity.bindingHash ?? null },
		readiness: identity.mediaSha256 ? "PINNED_BYTES" : "AWAITING_MEDIA_VERSION",
	});
}
