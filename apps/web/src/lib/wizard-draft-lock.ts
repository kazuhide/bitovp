/** Serialize the localStorage comparison and its write across same-origin tabs. */
export function withWizardDraftLock(key: string, apply: () => void) {
	try {
		if (navigator.locks) {
			void navigator.locks.request(key, apply).catch(() => {});
			return;
		}
		// Web Locks require HTTPS. An IndexedDB readwrite transaction gives a
		// plain HTTP installation the same cross-tab exclusion without storing form data.
		const open = indexedDB.open("bitovp-wizard-draft-coordination", 1);
		open.onupgradeneeded = () => open.result.createObjectStore("access");
		open.onsuccess = () => {
			const db = open.result;
			try {
				const tx = db.transaction("access", "readwrite");
				tx.objectStore("access").get(key).onsuccess = apply;
			} catch {
				// A revoked storage permission prevents the transaction.
			} finally {
				db.close();
			}
		};
	} catch {
		// Storage can be disabled by browser permissions. Editing remains available.
	}
}
