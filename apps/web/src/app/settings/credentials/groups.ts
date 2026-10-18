import type { CredentialGroup } from "@bitovp/core";
import type { MessageKey } from "@/lib/i18n";

/**
 * Heading per credential group .
 *
 * Shared by the list and the add dialog's provider dropdown. It lived in the
 * list component, so grouping the list left the dropdown flat — eighteen
 * providers in one run with a DRM content key between two object stores, which
 * the owner then asked about. One `Record` in one place, and a group added
 * later cannot ship unlabelled in either.
 */
export const GROUP_HEADING: Record<CredentialGroup, MessageKey> = {
	STORAGE: "settings.groupStorage",
	DRM: "settings.groupDrm",
	LIVE_INGEST: "settings.groupLiveIngest",
	INTEGRATION: "settings.groupIntegration",
};
