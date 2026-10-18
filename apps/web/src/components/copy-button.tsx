"use client";

import { Check, Copy } from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/context";

/**
 * The single clipboard state machine used by standard and custom-shaped copy
 * controls. Only a fulfilled Clipboard promise produces a success state.
 */
export function useClipboardCopy(value: string): {
	copied: boolean;
	copy: () => Promise<void>;
} {
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
	const copy = useCallback(async () => {
		try {
			await navigator.clipboard.writeText(value);
		} catch {
			return; // clipboard denied (permissions/insecure context)
		}
		setCopied(true);
		if (timer.current) {
			clearTimeout(timer.current);
		}
		timer.current = setTimeout(() => setCopied(false), 1500);
	}, [value]);
	return { copied, copy };
}

/** Polite, localized confirmation shared by every clipboard control. */
export function ClipboardCopyStatus({ copied }: { copied: boolean }) {
	const { t } = useT();
	return (
		<span
			role="status"
			aria-live="polite"
			aria-atomic="true"
			className="sr-only"
		>
			{copied ? t("common.copied") : ""}
		</span>
	);
}

/**
 * Clipboard button with a transient "copied" check — used for ingest
 * coordinates, plan JSON and other copyable operator values.
 */
export function CopyButton({
	value,
	label,
	children,
}: {
	value: string;
	label: string;
	children?: ReactNode;
}) {
	const { copied, copy } = useClipboardCopy(value);
	return (
		<>
			<Button variant="ghost" size="sm" aria-label={label} onClick={copy}>
				{children}
				{copied ? (
					<Check aria-hidden className="h-3.5 w-3.5 text-emerald-400" />
				) : (
					<Copy aria-hidden className="h-3.5 w-3.5" />
				)}
			</Button>
			<ClipboardCopyStatus copied={copied} />
		</>
	);
}
