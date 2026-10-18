"use client";

import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { ReactNode } from "react";
import { useT } from "@/lib/i18n/context";

type DialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description?: string;
	/** Wide layout for browsing UIs (storage picker). */
	wide?: boolean;
	children: ReactNode;
};

export function Dialog({
	open,
	onOpenChange,
	title,
	description,
	wide = false,
	children,
}: DialogProps) {
	const { t } = useT();
	return (
		<DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/60" />
				<DialogPrimitive.Content
					className={`fixed top-1/2 left-1/2 z-50 max-h-[85vh] w-full ${
						wide ? "max-w-4xl" : "max-w-lg"
					} -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950 p-6 shadow-xl`}
				>
					<div className="flex items-start justify-between gap-4">
						{/*
						 * min-w-0 + wrap-anywhere (UI loop 2026-08-21, measured):
						 * callers interpolate filenames and manifest URLs into
						 * title/description; a slash/underscore path has no
						 * soft-wrap points, so without these the flex item's
						 * min-content floors at the full token and the whole
						 * dialog pans sideways — the close button measured 95px
						 * past the panel edge on a 129-char manifest URL.
						 */}
						<div className="min-w-0">
							<DialogPrimitive.Title className="wrap-anywhere font-semibold text-base text-zinc-50">
								{title}
							</DialogPrimitive.Title>
							{description ? (
								<DialogPrimitive.Description className="wrap-anywhere mt-1 text-xs text-zinc-400">
									{description}
								</DialogPrimitive.Description>
							) : (
								<DialogPrimitive.Description className="sr-only">
									{title}
								</DialogPrimitive.Description>
							)}
						</div>
						<DialogPrimitive.Close
							aria-label={t("ui.close")}
							className="rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
						>
							<X aria-hidden className="h-4 w-4" />
						</DialogPrimitive.Close>
					</div>
					<div className="mt-4">{children}</div>
				</DialogPrimitive.Content>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	);
}
