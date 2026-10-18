/**
 * A fixture's stand-in credential id.
 *
 * Lived in `apps/web/.../plan-import.ts`, which also depends (type-only) on a React
 * component, so only this two-line predicate came along when the wizard's plan-producing
 * code moved into core. `plan-import.ts` now re-exports it, so the web side is unchanged.
 */
export function isPlaceholderCredentialId(id: string): boolean {
	return id.startsWith("00000000-");
}

/**
 * The wizard's IMPORT submit expression, moved here for the same reason `buildPlan` was.
 *
 * `wizard.tsx` submits `imported ? buildSubmissionPlan(imported, accountId) : buildPlan(state)`
 * — two authoring paths, both real. The form path cannot author every field (GCS `region`, by
 * documented design), so a scenario that needs one is submitted through THIS branch. Both are
 * the product's own code, which is the point.
 *
 * `apps/web`'s `plan-import.ts` re-exports it, so its call sites are unchanged.
 */
export function buildSubmissionPlan(
	imported: { raw: Record<string, unknown> },
	accountId: string,
): Record<string, unknown> {
	if (importedAccountId(imported)) {
		return imported.raw;
	}
	const bitmovin = (imported.raw.bitmovin ?? {}) as Record<string, unknown>;
	return { ...imported.raw, bitmovin: { ...bitmovin, accountId } };
}

/** The account the plan itself carries, when it does. */
export function importedAccountId(imported: {
	raw: Record<string, unknown>;
}): string | undefined {
	const bitmovin = imported.raw.bitmovin as Record<string, unknown> | undefined;
	const id = bitmovin?.accountId;
	return typeof id === "string" && id !== "" ? id : undefined;
}
