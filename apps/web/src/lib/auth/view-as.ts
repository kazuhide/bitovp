/** Owner view-as is a metadata/dashboard reader, never a generic GET capability. */
const PAGE_PREFIXES = [
	"/dashboard",
	"/vod",
	"/live",
	"/library",
	"/qc",
	"/presets",
] as const;
const API_PREFIXES = [
	"/api/dashboard",
	"/api/encoding-jobs",
	"/api/live-channels",
	"/api/library",
	"/api/vmaf-jobs",
	"/api/presets",
	"/api/storage-presets",
	"/api/alert-rules",
	"/api/settings/player",
	"/api/settings/branding",
	"/api/settings/features",
	"/api/settings/live-heartbeat",
] as const;
function under(path: string, prefix: string) {
	return path === prefix || path.startsWith(`${prefix}/`);
}
export function viewAsMayRead(path: string, method: string): boolean {
	if (method !== "GET" && method !== "HEAD") return false;
	if (
		/\/storage(?:\/|$)|stream-keys|final-heartbeat|\/export(?:\/|$)/.test(path)
	)
		return false;
	if (path === "/") return true;
	// The dashboard account selector needs the ciphertext-free account summaries.
	if (path === "/api/bitmovin-accounts") return true;
	return (path.startsWith("/api/") ? API_PREFIXES : PAGE_PREFIXES).some(
		(prefix) => under(path, prefix),
	);
}
