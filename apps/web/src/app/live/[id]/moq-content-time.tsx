"use client";

import { type RefObject, useEffect, useState } from "react";
import { useT } from "@/lib/i18n/context";
import { observeMoqContentTime } from "@/lib/moq-player/content-time";

export function MoqContentTime({
	mediaRef,
}: {
	mediaRef: RefObject<HTMLElement | null>;
}) {
	const { t } = useT();
	const [epoch, setEpoch] = useState<number | null>(null);
	useEffect(() => {
		const host = mediaRef.current;
		let alive = true;
		let generation = 0;
		let source: HTMLCanvasElement | HTMLVideoElement | null = null;
		let dispose: (() => void) | undefined;
		function attach() {
			const next =
				host instanceof HTMLVideoElement || host instanceof HTMLCanvasElement
					? host
					: (host?.querySelector<HTMLCanvasElement>("canvas") ??
						host?.querySelector<HTMLVideoElement>(
							"video:not([data-bitovp-moq-canvas-mirror])",
						) ??
						null);
			if (source === next) return;
			const ownGeneration = ++generation;
			dispose?.();
			source = next;
			setEpoch(null);
			dispose = next
				? observeMoqContentTime(next, (value) => {
						if (alive && ownGeneration === generation) setEpoch(value);
					})
				: undefined;
		}
		setEpoch(null);
		attach();
		const observer = new MutationObserver(attach);
		if (host) observer.observe(host, { childList: true, subtree: true });
		return () => {
			alive = false;
			generation++;
			observer.disconnect();
			dispose?.();
		};
	}, [mediaRef]);
	const date = epoch === null ? null : new Date(epoch);
	const iso =
		date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
	return (
		<p
			data-moq-content-clock
			aria-live="off"
			className="flex flex-wrap gap-x-2 text-xs text-zinc-400"
		>
			<span>{t("moqPlayback.contentTime")}</span>
			{iso ? (
				<time
					dateTime={iso}
					data-moq-content-time={iso}
					className="font-mono tabular-nums text-zinc-200"
				>
					{iso.replace("T", " ").replace("Z", " UTC")}
				</time>
			) : (
				<span>—</span>
			)}
		</p>
	);
}
