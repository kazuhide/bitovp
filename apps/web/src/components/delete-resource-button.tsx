"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useT } from "@/lib/i18n/context";

/**
 * Shared delete affordance for the four deletable resources (VOD jobs, live
 * channels, feeder sessions, VMAF reports). One destructive button that:
 *
 *  - when the resource is still ACTIVE, renders DISABLED with a hover/focus
 *    tooltip ("stop before deleting") instead of erroring — matching the
 *    route's 409 terminal-only guard (the user never hits the error path for a
 *    known-active row);
 *  - otherwise opens a confirmation Dialog (delete is irreversible and removes
 *    local dependents), and only on explicit confirm runs `onConfirm`.
 *
 * The caller owns the mutation: it passes `pending`/`error` and does the
 * refetch/redirect in its own onSuccess, so this component stays surface-
 * agnostic (list row vs. detail header).
 */
export function DeleteResourceButton({
	resourceLabel,
	disabled = false,
	disabledReason = "Stop it before deleting",
	confirmTitle,
	confirmDescription,
	confirmLabel,
	pending = false,
	error,
	onConfirm,
	size = "sm",
}: {
	/** Used in the default button label's aria-label, e.g. "Delete job". */
	resourceLabel: string;
	/** True while the resource is active (non-terminal) — disables + tooltips. */
	disabled?: boolean;
	/** Tooltip shown on the disabled button. */
	disabledReason?: string;
	confirmTitle: string;
	confirmDescription: string;
	/** Label on the confirm (destructive) button inside the dialog. */
	confirmLabel?: string;
	/** Mutation in-flight — disables the confirm button. */
	pending?: boolean;
	/** Optional already-formatted error string to show under the trigger. */
	error?: string | null;
	/** Runs only after explicit confirmation. */
	onConfirm: () => void;
	size?: "sm" | "default";
}) {
	const { t } = useT();
	const [open, setOpen] = useState(false);

	if (disabled) {
		// Disabled + tooltip rather than an error path (the 409 guard's UI mirror).
		return (
			<span className="group/del relative inline-flex">
				<Button
					variant="destructive"
					size={size}
					disabled
					aria-label={t("common.deleteAriaDisabled", {
						resource: resourceLabel,
					})}
				>
					{t("common.delete")}
				</Button>
				<span
					role="tooltip"
					className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1 hidden w-48 -translate-x-1/2 rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-200 leading-snug shadow-lg group-hover/del:block group-focus-within/del:block"
				>
					{disabledReason}
				</span>
			</span>
		);
	}

	return (
		<>
			<Button
				variant="destructive"
				size={size}
				aria-label={t("common.deleteAria", { resource: resourceLabel })}
				onClick={() => setOpen(true)}
			>
				{t("common.delete")}
			</Button>
			{error ? (
				<p role="alert" className="text-red-400 text-xs">
					{error}
				</p>
			) : null}
			<Dialog
				open={open}
				onOpenChange={(next) => {
					if (!next) {
						setOpen(false);
					}
				}}
				title={confirmTitle}
				description={confirmDescription}
			>
				<div className="flex justify-end gap-2">
					<Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
						{t("common.cancel")}
					</Button>
					<Button
						variant="destructive"
						size="sm"
						disabled={pending}
						onClick={() => {
							setOpen(false);
							onConfirm();
						}}
					>
						{pending
							? t("common.deleting")
							: (confirmLabel ?? t("common.delete"))}
					</Button>
				</div>
			</Dialog>
		</>
	);
}
