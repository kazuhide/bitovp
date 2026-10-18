"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

/**
 * Compact, inline copyable id — the monospace value plus a transient "copied"
 * check. Mirrors bm-xray's CopyableId affordance for the resource tree (a
 * scannable id-table where every Bitmovin id is one click from the clipboard).
 * For full-width operator values (plan JSON, ingest coords) use CopyButton.
 */

function useCopied(): [boolean, () => void] {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (timer.current) {
				clearTimeout(timer.current);
			}
		},
		[],
	);
	return [
		copied,
		() => {
			setCopied(true);
			if (timer.current) {
				clearTimeout(timer.current);
			}
			timer.current = setTimeout(() => setCopied(false), 1500);
		},
	];
}

function CopyIcon({ copied }: { copied: boolean }) {
	return copied ? (
		<Check aria-hidden className="h-3 w-3 shrink-0 text-emerald-400" />
	) : (
		<Copy aria-hidden className="h-3 w-3 shrink-0 text-zinc-600" />
	);
}

export function CopyableId({
	value,
	label,
	className,
	href,
	onNavigate,
}: {
	value: string;
	label?: string;
	className?: string;
	/** : when the id's PRODUCER is on this page, the value becomes
	    an in-page link to it (the copy affordance stays a separate button —
	    one control, one action). `onNavigate` runs on click so the caller can
	    mount the target first (e.g. switch to the Resources tab). */
	href?: string;
	onNavigate?: (href: string) => void;
}) {
	const { t } = useT();
	const [copied, markCopied] = useCopied();
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(value);
		} catch {
			return; // clipboard denied (permissions/insecure context)
		}
		markCopied();
	};
	if (href) {
		return (
			<span
				className={cn(
					"inline-flex max-w-full items-center gap-1 rounded px-1 py-0.5 font-mono text-[11px] text-zinc-400",
					className,
				)}
			>
				<a
					href={href}
					title={value}
					className="truncate underline decoration-dotted underline-offset-2 hover:text-emerald-300"
					onClick={(e) => {
						// The caller owns the whole jump (tab switch + focus +
						// scroll) — the native hash navigation would race it and
						// scroll before the target mounts (review-181 I2). Only
						// when a caller IS handling it: unconditional
						// preventDefault made a bare-href chip a dead link
						// (review-181 F3).
						if (onNavigate) {
							e.preventDefault();
							onNavigate(href);
						}
					}}
				>
					{value}
				</a>
				<button
					type="button"
					aria-label={t("uiX.copyLabelledValue", {
						label: label ?? t("uiX.idNoun"),
						value,
					})}
					onClick={copy}
					className="rounded p-0.5 transition-colors hover:bg-zinc-800"
				>
					<CopyIcon copied={copied} />
				</button>
			</span>
		);
	}
	return (
		<button
			type="button"
			aria-label={t("uiX.copyLabelledValue", {
				label: label ?? t("uiX.idNoun"),
				value,
			})}
			title={value}
			onClick={copy}
			className={cn(
				"inline-flex max-w-full items-center gap-1 rounded px-1 py-0.5 font-mono text-[11px] text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200",
				className,
			)}
		>
			<span className="truncate">{value}</span>
			<CopyIcon copied={copied} />
		</button>
	);
}
