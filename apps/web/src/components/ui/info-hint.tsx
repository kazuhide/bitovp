"use client";

import { Info } from "lucide-react";
import { Popover } from "radix-ui";
import { useId, useRef } from "react";
import { useT } from "@/lib/i18n/context";
import { helpContentProps, useHelpInteraction } from "./use-help-overlay";

/** Short help remains the trigger's accessible description, including while hidden. */
export function InfoHint({
	text,
	label,
	labelFor,
}: {
	text: string;
	label?: string;
	labelFor?: string;
}) {
	const { t } = useT();
	const tooltipId = useId();
	const rootRef = useRef<HTMLSpanElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const help = useHelpInteraction(rootRef, triggerRef, panelRef);
	return (
		<Popover.Root
			open={help.shown}
			onOpenChange={help.onOpenChange}
			modal={help.pinned && !!rootRef.current?.closest('[role="dialog"]')}
		>
			<span ref={rootRef} className="inline-flex align-middle">
				<Popover.Trigger asChild>
					<button
						ref={triggerRef}
						type="button"
						style={{ pointerEvents: "auto" }}
						aria-label={
							label ??
							(labelFor
								? t("uiX.moreInformationFor", { label: labelFor })
								: t("ui.moreInformation"))
						}
						aria-describedby={tooltipId}
						aria-controls={help.shown ? tooltipId : undefined}
						{...help.previewEvents}
						onClick={help.onClick}
						className="inline-flex text-zinc-500 hover:text-zinc-300 focus-visible:text-zinc-300 focus:outline-none"
					>
						<Info className="h-3.5 w-3.5" aria-hidden="true" />
					</button>
				</Popover.Trigger>
				{!help.shown && (
					<span role="tooltip" id={tooltipId} hidden>
						{text}
					</span>
				)}
				<Popover.Portal>
					<Popover.Content
						ref={panelRef}
						role="tooltip"
						id={tooltipId}
						tabIndex={-1}
						side="top"
						align="center"
						{...helpContentProps}
						{...help.previewEvents}
						onOpenAutoFocus={help.onOpenAutoFocus}
						onCloseAutoFocus={help.onCloseAutoFocus}
						onEscapeKeyDown={help.onEscapeKeyDown}
						onPointerDownOutside={help.onPointerDownOutside}
						className="z-50 block w-64 rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-200 leading-snug shadow-lg"
					>
						{text}
					</Popover.Content>
				</Popover.Portal>
			</span>
		</Popover.Root>
	);
}
