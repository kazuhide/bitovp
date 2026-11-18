import { z } from "zod";

export const REEDIT_STORAGE_PREFIX = "bitovp:library:reedit:";
export const createdEditShape = z.object({ id: z.uuid(), contentId: z.uuid() });
const pendingEditShape = z.strictObject({
	title: z.string().trim().min(1).max(500),
	requestKey: z.uuid(),
	created: createdEditShape.optional(),
});

export function retainPendingEdit(storageKey: string, title: string) {
	const value = window.sessionStorage.getItem(storageKey);
	if (value !== null) return pendingEditShape.parse(JSON.parse(value));
	const pending = pendingEditShape.parse({
		title,
		requestKey: crypto.randomUUID(),
	});
	window.sessionStorage.setItem(storageKey, JSON.stringify(pending));
	return pending;
}

/** Release the saved request only after the destination editor loads its draft. */
export function finishReeditNavigation(
	organizationId: string,
	projectId: string,
	contentId: string,
) {
	try {
		const storage = window.sessionStorage;
		const prefix = `${REEDIT_STORAGE_PREFIX}${organizationId}:`;
		for (let index = storage.length - 1; index >= 0; index--) {
			const key = storage.key(index);
			if (!key?.startsWith(prefix)) continue;
			const value = storage.getItem(key);
			if (!value) continue;
			try {
				const result = pendingEditShape.parse(JSON.parse(value));
				if (
					result.created?.id === projectId &&
					result.created.contentId === contentId
				)
					storage.removeItem(key);
			} catch {
				// A different or invalid saved request must stay untouched.
			}
		}
	} catch {
		// Browser storage can be unavailable after a successful re-edit.
	}
}
