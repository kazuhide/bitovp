"use client";

import type {
	LiveChannelDerivedStatus,
	ProviderLifecycleView,
} from "@bitovp/core";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/lib/i18n/context";
import { liveStatusPresentation } from "./live-shared";

/**
 * One customer-facing status presentation for the detail header and fleet.
 * Keeping the label beside the tone prevents either surface from regressing to
 * a bare green RUNNING while the current Bitmovin encoding is unconfirmed.
 */
export function LiveStatusBadge({
	status,
	providerLifecycle,
}: {
	status: LiveChannelDerivedStatus;
	providerLifecycle: ProviderLifecycleView;
}) {
	const { t } = useT();
	const presentation = liveStatusPresentation(status, providerLifecycle);
	return (
		<Badge tone={presentation.tone}>
			{presentation.providerUnconfirmed
				? t("live.providerStatusUnconfirmed", { status })
				: status}
		</Badge>
	);
}
