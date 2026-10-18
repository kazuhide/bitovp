"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useT } from "@/lib/i18n/context";

/**
 * "Add a credential" beside a credential picker (owner request 2026-08-19).
 *
 * An operator part-way through a wizard often needs a credential they have not
 * registered — and until now the only route was to abandon the form, go to
 * Settings, come back, and start over. This links straight to the add dialog
 * (`/settings/credentials?new=1`).
 *
 * OPENS IN A NEW TAB, deliberately. The wizard holds unsaved state that no
 * route change survives: a plain link would trade "you cannot create a
 * credential from here" for "you lost the ladder you just built", which is a
 * worse bargain. The new tab keeps the half-filled form alive, and the picker
 * refreshes when focus comes back.
 *
 * `onReturn` is how that refresh happens — the caller re-fetches its credential
 * list. Without it the operator would create a credential, return, and not see
 * it, which reads as a failure of the thing they just did.
 */
export function NewCredentialLink() {
	const { t } = useT();
	const queryClient = useQueryClient();
	return (
		<a
			href="/settings/credentials?new=1"
			target="_blank"
			rel="noopener noreferrer"
			className="inline-flex items-center gap-1 text-emerald-400 text-xs hover:text-emerald-300 hover:underline"
			onClick={() => {
				// Fires when the tab OPENS, not when the credential is saved, so
				// the refetch is scheduled for the operator's return — there is
				// nothing new to fetch yet at click time. Every credential
				// picker in the app reads the same `["credentials"]` key, so one
				// invalidation refreshes whichever wizard sent them.
				const refresh = () => {
					queryClient.invalidateQueries({ queryKey: ["credentials"] });
					window.removeEventListener("focus", refresh);
				};
				window.addEventListener("focus", refresh);
			}}
		>
			<Plus aria-hidden className="h-3 w-3" />
			{t("ui.addCredentialNewTab")}
		</a>
	);
}
