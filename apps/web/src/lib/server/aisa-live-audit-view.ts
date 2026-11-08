/** These are the AISA-specific audit namespaces emitted by BitOVP. */
export const AISA_AUDIT_PATH_PREFIXES = [
	"/ai-scene-analysis/live-analyses",
	"/api/live/analyses",
	"/live-channels/import-analysis",
] as const;

export function isAisaAuditPath(path: unknown): boolean {
	return (
		typeof path === "string" &&
		AISA_AUDIT_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))
	);
}
