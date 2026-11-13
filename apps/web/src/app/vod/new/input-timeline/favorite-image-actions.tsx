import type { VodInputFavoriteWire } from "@bitovp/core/vod-input-timeline";
import { FileImage } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFavoriteLabels } from "./favorite-labels";

export function FavoriteImageActions({
	item,
	blocked,
	canUseLogo,
	canUseMedia,
	reason,
	onLogo,
	onClip,
}: {
	item: VodInputFavoriteWire;
	blocked: boolean;
	canUseLogo: boolean;
	canUseMedia: boolean;
	reason: string | null;
	onLogo: () => void;
	onClip: () => void;
}) {
	const l = useFavoriteLabels();
	const unavailable = item.availability !== "AVAILABLE";
	return (
		<div className="min-w-0 flex-1">
			<div className="flex min-w-0 items-center gap-2 px-1 text-xs">
				<FileImage aria-hidden className="h-5 w-5 shrink-0 text-zinc-500" />
				<span className="truncate text-zinc-200" title={item.objectKey}>
					{item.label}
				</span>
			</div>
			<div className="mt-1 flex flex-wrap items-center gap-1">
				<Button
					type="button"
					size="sm"
					variant="ghost"
					aria-label={l.imageClip(item.label)}
					title={
						unavailable
							? (reason ?? undefined)
							: !canUseMedia
								? l.cap
								: l.imageClip(item.label)
					}
					disabled={blocked || unavailable || !canUseMedia}
					onClick={onClip}
				>
					{l.placeImage}
				</Button>
				<Button
					type="button"
					size="sm"
					variant="ghost"
					aria-label={l.logo(item.label)}
					title={
						unavailable
							? (reason ?? undefined)
							: !canUseLogo
								? l.needsVideo
								: l.logo(item.label)
					}
					disabled={blocked || unavailable || !canUseLogo}
					onClick={onLogo}
				>
					{l.logoAction}
				</Button>
			</div>
			{unavailable && reason && (
				<p className="px-1 text-xs text-zinc-400">{reason}</p>
			)}
		</div>
	);
}
