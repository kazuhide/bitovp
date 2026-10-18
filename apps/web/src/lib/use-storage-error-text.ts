"use client";

import { useT } from "@/lib/i18n/context";
import {
	type MessageKey,
	storageErrorDisplay,
	storageListErrorDisplay,
} from "@/lib/storage-error-keys";

/**
 * One place that turns a failed storage request into text an operator can act
 * on .
 *
 * Both storage UIs used to render `error.message` verbatim, which is how
 * "AccessDenied (upstream 403)" reached the screen in English with no cause and
 * no next step. It lives in `lib/` rather than in either screen because the
 * picker previously re-implemented these three lines inline — and two copies of
 * one behaviour drifting apart across exactly this file pair is what #144 IS.
 */
export function useStorageErrorText() {
	const { t } = useT();
	/**
	 * `scope` picks which sentence, and it is not cosmetic: the object-level
	 * 403 text tells the operator to pick another bucket, which is false when
	 * the LIST is what was refused.
	 */
	return (
		error: unknown,
		fallback: MessageKey,
		scope: "object" | "list" = "object",
	) => {
		const shown =
			scope === "list"
				? storageListErrorDisplay(error, fallback)
				: storageErrorDisplay(error, fallback);
		return shown.kind === "key" ? t(shown.key) : shown.text;
	};
}
