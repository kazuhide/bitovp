"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n/context";
import type { EditingRenderView } from "@/lib/library-editing";
import { bindPassiveRequestUrl } from "@/lib/passive-request";

export function boundExportLinks(
	artifact: NonNullable<EditingRenderView["artifact"]>,
	organizationId: string | null | undefined,
) {
	if (!organizationId) return null;
	try {
		const base = `/api/library/artifacts/${artifact.id}`;
		const media = bindPassiveRequestUrl(`${base}/media`, organizationId);
		const download = bindPassiveRequestUrl(`${base}/download`, organizationId);
		return artifact.url === media && artifact.downloadUrl === download
			? { media, download }
			: null;
	} catch {
		return null;
	}
}

export function ClipExportVideo({
	src,
	title,
	autoPlay = false,
	onFrame,
}: {
	src: string;
	title: string;
	autoPlay?: boolean;
	onFrame?: (video: HTMLVideoElement) => void;
}) {
	const { t } = useT();
	const [failed, setFailed] = useState(false);
	return (
		<div className="min-w-0 space-y-2">
			<video
				controls
				muted
				playsInline
				autoPlay={autoPlay}
				preload={onFrame ? "auto" : "metadata"}
				src={src}
				aria-label={title}
				className="mx-auto block max-h-[65vh] max-w-full rounded-md bg-black object-contain"
				onError={() => setFailed(true)}
				onLoadedData={(event) => onFrame?.(event.currentTarget)}
			/>
			{failed && (
				<p role="alert" className="text-amber-300 text-sm">
					{t("editing.autoPortrait.videoError")}
				</p>
			)}
		</div>
	);
}

/** Make a shelf thumbnail from the video that the operator chose to load. */
export function exportPoster(video: HTMLVideoElement) {
	if (!video.videoHeight || !video.videoWidth) return null;
	const canvas = document.createElement("canvas");
	const scale = 192 / Math.max(video.videoWidth, video.videoHeight);
	canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
	canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
	try {
		const context = canvas.getContext("2d");
		if (!context) return null;
		context.drawImage(video, 0, 0, canvas.width, canvas.height);
		return canvas.toDataURL("image/jpeg", 0.82);
	} catch {
		return null;
	}
}
