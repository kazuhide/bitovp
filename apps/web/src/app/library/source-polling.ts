import type { LibrarySourceView } from "@bitovp/core";

/** ERROR can be retried automatically by the worker, so keep checking it. */
export function sourcePollingInterval(
	state: LibrarySourceView["state"] | undefined,
): number | false {
	if (state === "PENDING" || state === "RUNNING") return 2000;
	return state === "ERROR" ? 10000 : false;
}
