"use client";
import { Film } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { useDocumentOrganization } from "@/components/providers";
import { useT } from "@/lib/i18n/context";
import type { EditingThumbnailReference } from "@/lib/library-editing";
import { EXPECTED_ORGANIZATION_QUERY } from "@/lib/passive-request";
import { requestClipThumbnail } from "./clip-thumbnail-loader";

export function ClipThumbnail({
	reference,
}: {
	reference?: EditingThumbnailReference | null;
}) {
	const { t, locale } = useT();
	const organizationId = useDocumentOrganization();
	const host = useRef<HTMLDivElement>(null);
	const identity = JSON.stringify([reference, locale, organizationId]);
	const [result, setResult] = useState<{
		identity: string;
		image: string | null;
	}>();
	const image = result?.identity === identity ? result.image : null;
	useEffect(() => {
		if (
			!reference ||
			!host.current ||
			!organizationId ||
			new URL(reference.url, window.location.origin).searchParams.get(
				EXPECTED_ORGANIZATION_QUERY,
			) !== organizationId ||
			typeof IntersectionObserver === "undefined"
		)
			return;
		let controller: AbortController | undefined;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					if (controller && !controller.signal.aborted) return;
					controller = new AbortController();
					const pending = controller;
					void requestClipThumbnail(reference, locale, pending.signal)
						.catch(() => null)
						.then((image) => {
							if (pending.signal.aborted) return;
							setResult({ identity, image });
							observer.disconnect();
						});
				} else controller?.abort();
			},
			{ rootMargin: "100px" },
		);
		observer.observe(host.current);
		return () => {
			observer.disconnect();
			controller?.abort();
		};
	}, [reference, locale, organizationId, identity]);
	return (
		<div
			ref={host}
			data-clip-thumbnail=""
			title={image ? undefined : t("library.thumbnailUnavailable")}
			className="relative flex size-20 shrink-0 items-center justify-center overflow-hidden rounded bg-zinc-900 text-zinc-500"
		>
			{image ? (
				<Image
					src={image}
					alt=""
					unoptimized
					width={reference?.width ?? 192}
					height={reference?.height ?? 192}
					className="h-full w-full object-contain"
				/>
			) : (
				<Film className="size-5" aria-hidden="true" />
			)}
		</div>
	);
}
