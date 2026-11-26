/**
 * What a new VOD job is for. `streaming` builds a ladder with manifests; `file` writes
 * finished files. The flow picks the state the wizard starts from and the steps it
 * shows — the plan model underneath is the same.
 *
 * Kept free of browser and React APIs: the page that resolves the flow runs on the
 * server. The cookie writer lives in `vod-flow-preference.ts`.
 */
export const VOD_FLOWS = ["streaming", "file"] as const;
export type VodFlow = (typeof VOD_FLOWS)[number];
export const VOD_FLOW_COOKIE = "bitovp-vod-flow";

export function parseVodFlow(
	value: string | null | undefined,
): VodFlow | undefined {
	return VOD_FLOWS.find((flow) => flow === value);
}

/** The URL decides. Without it, the flow last chosen in this browser; without that, streaming. */
export function resolveVodFlow(
	param: string | null | undefined,
	remembered: string | null | undefined,
): VodFlow {
	return parseVodFlow(param) ?? parseVodFlow(remembered) ?? "streaming";
}

export function vodFlowHref(flow: VodFlow): string {
	return `/vod/new?flow=${flow}`;
}
