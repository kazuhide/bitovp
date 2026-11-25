import type { ResourceOwner } from "./route";

/** This schema cannot establish retirement for a replaced Live RTMP encoder. */
export function removalAllowed(owner: ResourceOwner, locallyTerminal: boolean) {
	return "jobId" in owner && locallyTerminal;
}
