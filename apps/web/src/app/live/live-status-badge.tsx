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
	encoderEndUnconfirmed = false,
}: {
	status: LiveChannelDerivedStatus;
	providerLifecycle: ProviderLifecycleView;
	encoderEndUnconfirmed?: boolean;
}) {
	const { t } = useT();
	const presentation = liveStatusPresentation(status, providerLifecycle);
	return (
		<Badge tone={encoderEndUnconfirmed ? "warn" : presentation.tone}>
			{status === "STOPPED" && providerLifecycle === "TERMINAL"
				? t("live.encoderStopped")
				: encoderEndUnconfirmed
					? t(
							providerLifecycle === "RUNNING"
								? "live.encoderActive"
								: "live.encoderStatusUnverified",
						)
					: presentation.providerUnconfirmed
						? t("live.providerStatusUnconfirmed", { status })
						: status}
		</Badge>
	);
}
