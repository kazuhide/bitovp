/** Serialize the localStorage comparison and its write across same-origin tabs. */
export function withWizardDraftLock(key: string, apply: () => void) {
	try {
		if (navigator.locks) {
			return navigator.locks.request(key, apply).catch(() => {});
		}
		// Web Locks require HTTPS. An IndexedDB readwrite transaction gives a
		// plain HTTP installation the same cross-tab exclusion without storing form data.
		return new Promise<void>((resolve) => {
			const open = indexedDB.open("bitovp-wizard-draft-coordination", 1);
			open.onupgradeneeded = () => open.result.createObjectStore("access");
			open.onerror = () => resolve();
			let blocked = false;
			open.onblocked = () => {
				blocked = true;
				resolve();
			};
			open.onsuccess = () => {
				const db = open.result;
				try {
					if (blocked) return;
					const tx = db.transaction("access", "readwrite");
					tx.oncomplete = tx.onabort = () => resolve();
					tx.objectStore("access").get(key).onsuccess = apply;
				} catch {
					resolve();
				} finally {
					db.close();
				}
			};
		}).catch(() => {});
	} catch {
		// Storage can be disabled by browser permissions. Editing remains available.
		return Promise.resolve();
	}
}
