"use client";
import { Film, LoaderCircle, TriangleAlert } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n/context";
import { libraryMp4IsMissing } from "@/lib/playback-mp4-status";
import {
	requestThumbnail,
	type ThumbnailSource,
} from "./catalog-thumbnail-loader";

export function CatalogThumbnail({
	source,
	fallback,
	compact = false,
}: {
	source?: ThumbnailSource;
	fallback: string;
	compact?: boolean;
}) {
	const { t } = useT();
	const ref = useRef<HTMLDivElement>(null);
	const { kind, url, time, cacheKey, duration } = source ?? {};
	const identity = JSON.stringify([kind, url, time, cacheKey, duration]);
	const [result, setResult] = useState<{
		identity: string;
		frame: string | null;
		unavailable?: boolean;
		missing?: boolean;
	}>();
	const frame = result?.identity === identity ? result.frame : null;
	const unavailable = result?.identity === identity && result.unavailable;
	const missing = unavailable && result?.missing;
	const pending = Boolean(
		kind && url && time !== undefined && result?.identity !== identity,
	);
	useEffect(() => {
		setResult(undefined);
		if (
			!kind ||
			!url ||
			time === undefined ||
			!ref.current ||
			typeof IntersectionObserver === "undefined"
		) {
			setResult({ identity, frame: null });
			return;
		}
		let controller: AbortController | undefined;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					if (controller && !controller.signal.aborted) return;
					controller = new AbortController();
					const request = controller;
					void requestThumbnail(
						{ kind, url, time, cacheKey, duration },
						request.signal,
					)
						.catch(() => null)
						.then(async (image) => {
							if (request.signal.aborted) return;
							setResult({ identity, frame: image, unavailable: !image });
							if (!image && kind === "MP4") {
								const missing = await libraryMp4IsMissing(url, request.signal);
								if (request.signal.aborted) return;
								setResult({
									identity,
									frame: null,
									unavailable: true,
									missing,
								});
							}
							observer.disconnect();
						});
				} else controller?.abort();
			},
			{ rootMargin: "100px" },
		);
		observer.observe(ref.current);
		return () => {
			observer.disconnect();
			controller?.abort();
		};
	}, [identity, cacheKey, duration, kind, url, time]);
	const label = pending
		? t("library.thumbnailLoading")
		: missing
			? t("library.thumbnailFileMissing")
			: unavailable
				? t("library.previewUnavailable")
				: fallback;
	const description = missing ? t("playback.mp4FileMissing") : label;
	return (
		<div
			ref={ref}
			title={frame ? undefined : description}
			className={`relative flex aspect-video items-center justify-center overflow-hidden bg-zinc-900 ${unavailable ? "text-amber-400" : "text-zinc-500"}`}
		>
			{frame ? (
				<Image
					src={frame}
					alt=""
					width={320}
					height={180}
					unoptimized
					className="absolute inset-0 h-full w-full object-cover"
				/>
			) : (
				<span className="flex flex-col items-center gap-2 text-xs">
					{pending ? (
						<LoaderCircle className="size-6 animate-spin" aria-hidden="true" />
					) : unavailable ? (
						<TriangleAlert
							className="size-6"
							role="img"
							aria-label={description}
						/>
					) : (
						<Film className="size-6" aria-hidden="true" />
					)}
					<span className={compact ? "sr-only" : undefined}>{label}</span>
				</span>
			)}
		</div>
	);
}
