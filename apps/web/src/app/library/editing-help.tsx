"use client";

import type { ReactNode } from "react";
import { HelpOverlay } from "@/components/ui/help-overlay";

/** Readable prose scoped to editing help, including content rendered in a portal. */
export function EditingHelpText({ children }: { children: ReactNode }) {
	return (
		<div className="space-y-3 text-pretty text-xs leading-relaxed [line-break:strict] [overflow-wrap:normal] [word-break:normal]">
			{children}
		</div>
	);
}

export function EditingHelp({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<HelpOverlay labelFor={label}>
			<EditingHelpText>{children}</EditingHelpText>
		</HelpOverlay>
	);
}

export function EditingDetails({
	summary,
	children,
}: {
	summary: string;
	children: ReactNode;
}) {
	return (
		<details className="min-w-0 space-y-3 text-zinc-400">
			<summary className="cursor-pointer text-pretty text-xs leading-relaxed">
				{summary}
			</summary>
			<EditingHelpText>{children}</EditingHelpText>
		</details>
	);
}
