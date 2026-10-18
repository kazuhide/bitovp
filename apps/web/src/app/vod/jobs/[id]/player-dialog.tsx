"use client";

import type { PlayerClientConfig, SceneAnalysisDocument } from "@bitovp/core";
import { Dialog } from "@/components/ui/dialog";
import { useT } from "@/lib/i18n/context";
import { PlaybackSurface } from "./playback-surface";

type PlayerDialogProps = {
	url: string | null;
	kind: "HLS" | "DASH" | null;
	diagnose?: { scope: "vod" | "live"; id: string; manifestKey: string };
	onClose: () => void;
	player?: PlayerClientConfig;
	sceneAnalysis?: SceneAnalysisDocument;
	seekRequest?: { seconds: number; requestId: number };
	analyticsMeta?: {
		videoId: string;
		title?: string;
		customData5?: string;
	};
};

/**
 * The enlarged view of a manifest. The player, its failure reporting and its
 * CORS diagnosis all live in `PlaybackSurface`, shared with the inline preview
 * panel — this is the dialog around it.
 */
export function PlayerDialog({
	url,
	kind,
	diagnose,
	onClose,
	player,
	sceneAnalysis,
	seekRequest,
	analyticsMeta,
}: PlayerDialogProps) {
	const { t } = useT();
	return (
		<Dialog
			open={url !== null}
			onOpenChange={(open) => {
				if (!open) {
					onClose();
				}
			}}
			title={kind === "DASH" ? t("ui.dashPlayback") : t("ui.hlsPlayback")}
			description={url ?? ""}
		>
			<PlaybackSurface
				player={player}
				sceneAnalysis={sceneAnalysis}
				seekRequest={seekRequest}
				analyticsMeta={analyticsMeta}
				url={url}
				kind={kind}
				autoPlay
				{...(diagnose ? { diagnose } : {})}
			/>
		</Dialog>
	);
}
