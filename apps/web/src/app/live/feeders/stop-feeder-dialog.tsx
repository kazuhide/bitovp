"use client";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useT } from "@/lib/i18n/context";

/**
 * Shared stop-confirm for feeder sessions — the standalone feeder detail
 * and the channel detail's embedded feeder table gate Stop behind the SAME
 * dialog (sessions are one-shot: stopping is irreversible, so neither
 * surface may stop on a bare click).
 */
export function StopFeederSessionDialog({
	open,
	stopping,
	onCancel,
	onConfirm,
}: {
	open: boolean;
	/** Disables the confirm button while the stop mutation is in flight. */
	stopping: boolean;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	const { t } = useT();
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					onCancel();
				}
			}}
			title={t("feeder.stopTitle")}
			description={t("feeder.stopBody")}
		>
			<div className="flex justify-end gap-2">
				<Button variant="secondary" size="sm" onClick={onCancel}>
					{t("common.cancel")}
				</Button>
				<Button
					variant="destructive"
					size="sm"
					disabled={stopping}
					onClick={onConfirm}
				>
					{t("feeder.stopSession")}
				</Button>
			</div>
		</Dialog>
	);
}
