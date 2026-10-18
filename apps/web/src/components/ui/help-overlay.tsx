"use client";

import { HelpCircle, X } from "lucide-react";
import { Popover } from "radix-ui";
import { type ReactNode, useId, useRef } from "react";
import { useT } from "@/lib/i18n/context";
import { helpContentProps, useHelpInteraction } from "./use-help-overlay";

/** Hover/focus previews; click pins a scrollable panel outside clipped containers. */
export function HelpOverlay({
	children,
	label,
	labelFor,
}: {
	children: ReactNode;
	label?: string;
	labelFor?: string;
}) {
	const { t } = useT();
	const rootRef = useRef<HTMLSpanElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const panelId = useId();
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
						aria-expanded={help.shown}
						aria-controls={help.shown ? panelId : undefined}
						aria-label={
							label ??
							(labelFor
								? t("uiX.moreInformationFor", { label: labelFor })
								: t("ui.moreInformation"))
						}
						{...help.previewEvents}
						onClick={help.onClick}
						className="inline-flex text-zinc-500 hover:text-zinc-300 focus-visible:text-zinc-300 focus:outline-none"
					>
						<HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
					</button>
				</Popover.Trigger>
				<Popover.Portal>
					<Popover.Content
						ref={panelRef}
						id={panelId}
						role="note"
						tabIndex={-1}
						side="bottom"
						align="start"
						{...helpContentProps}
						{...help.previewEvents}
						onOpenAutoFocus={help.onOpenAutoFocus}
						onCloseAutoFocus={help.onCloseAutoFocus}
						onEscapeKeyDown={help.onEscapeKeyDown}
						onPointerDownOutside={help.onPointerDownOutside}
						className="z-50 block w-80 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-[11px] text-zinc-200 leading-snug shadow-xl"
					>
						<button
							type="button"
							aria-label={t("common.close")}
							onClick={() => help.close(true)}
							className="float-right ml-2 text-zinc-500 hover:text-zinc-300"
						>
							<X className="h-3 w-3" aria-hidden="true" />
						</button>
						{children}
					</Popover.Content>
				</Popover.Portal>
			</span>
		</Popover.Root>
	);
}
