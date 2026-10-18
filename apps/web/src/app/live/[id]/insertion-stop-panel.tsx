"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { LiveChannelStatus } from "@/app/live/live-shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { apiFetch } from "@/lib/api";
import { RoleAccess } from "@/lib/auth/use-role-access";
import { localizedCustomerError } from "@/lib/customer-error";
import { useT } from "@/lib/i18n/context";
import { useAnnounce } from "./live-announcer";

/**
 * The emergency lever: `POST …/insertable-content/stop` — cut whatever
 * inserted content is PLAYING and put the live input back on air.
 *
 * This button used to sit on
 * top of the scheduled-content list as "Return to live now", which made two
 * things it is not look like one thing it is: it is not a reservation action
 * (a reservation is cancelled per row, in `SlateReservationsPanel`, and this
 * stop leaves every reservation exactly where it was), and pressing it says
 * nothing about whether anything WAS playing — the provider exposes no active
 * state for us to read, and answers a stop with nothing to stop by a 409,
 * which is surfaced verbatim below. So it is its own Operations section, its
 * copy says what it does and does not do, and it is confirm-gated like the
 * encoder's own Stop (`ChannelLifecycleActions`).
 *
 * The success line says the stop was ACCEPTED. It does not say the feed is
 * back — that is a claim about media, and nothing here has witnessed any.
 */
export function InsertedContentStopPanel({
	channelId,
	status,
	bitmovinAccountId,
}: {
	channelId: string;
	status: LiveChannelStatus;
	bitmovinAccountId: string | null;
}) {
	const { t } = useT();
	const queryClient = useQueryClient();
	const announce = useAnnounce();
	const [confirming, setConfirming] = useState(false);

	const stop = useMutation({
		mutationFn: () =>
			apiFetch<{ encodingId: string; stopped: boolean }>(
				`/api/live-channels/${channelId}/insertable-content/stop`,
				{ method: "POST", body: JSON.stringify({ bitmovinAccountId }) },
			),
		onSuccess: () => {
			setConfirming(false);
			announce(t("contentInsertion.stopped"));
			// The list is re-read, not edited: a stop changes what is playing,
			// and only the provider knows whether that moved a row's status.
			queryClient.invalidateQueries({
				queryKey: ["live-scheduled-content", channelId],
			});
		},
		onError: () => setConfirming(false),
	});

	if (status !== "RUNNING") {
		return (
			<p className="mt-2 text-sm text-zinc-500">
				{t("contentInsertion.stopNeedsRunning")}
			</p>
		);
	}
	if (!bitmovinAccountId) {
		return (
			<p className="mt-2 text-sm text-zinc-500">
				{t("prose.contentNoAccount")}
			</p>
		);
	}

	return (
		<div className="mt-2 space-y-3">
			<p className="max-w-2xl text-xs text-zinc-500">
				{t("contentInsertion.stopLead")}
			</p>
			<RoleAccess control="live.channel.inserted-content-stop">
				<div className="space-y-3">
					<Button
						variant="destructive"
						disabled={stop.isPending}
						onClick={() => setConfirming(true)}
					>
						{stop.isPending
							? t("contentInsertion.stopSending")
							: t("contentInsertion.stopAction")}
					</Button>
					{stop.error ? (
						<p role="alert" className="text-red-400 text-sm">
							{localizedCustomerError(
								t,
								stop.error,
								"contentInsertion.requestFailed",
							)}
						</p>
					) : null}
					{stop.isSuccess ? (
						<p className="text-emerald-400 text-sm">
							{t("contentInsertion.stopped")}
						</p>
					) : null}

					<Dialog
						open={confirming}
						onOpenChange={(open) => {
							if (!open) {
								setConfirming(false);
							}
						}}
						title={t("contentInsertion.stopConfirmTitle")}
						description={t("contentInsertion.stopConfirmBody")}
					>
						<div className="flex justify-end gap-2">
							<Button
								variant="secondary"
								size="sm"
								onClick={() => setConfirming(false)}
							>
								{t("common.cancel")}
							</Button>
							<Button
								variant="destructive"
								size="sm"
								disabled={stop.isPending}
								aria-busy={stop.isPending}
								onClick={() => stop.mutate()}
							>
								{stop.isPending
									? t("contentInsertion.stopSending")
									: t("contentInsertion.stopConfirm")}
							</Button>
							<span
								role="status"
								aria-live="polite"
								aria-atomic="true"
								className="sr-only"
							>
								{stop.isPending ? t("contentInsertion.stopSending") : ""}
							</span>
						</div>
					</Dialog>
				</div>
			</RoleAccess>
		</div>
	);
}
