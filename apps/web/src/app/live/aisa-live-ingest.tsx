"use client";

import { useQuery } from "@tanstack/react-query";
import { CopyableId } from "@/components/copyable-id";
import type { AisaIngest } from "@/lib/aisa-live/contracts";
import { apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";

export function AisaLiveIngest({
	accountId,
	analysisId,
	encodingId,
	running,
	embedded = false,
}: {
	accountId: string;
	analysisId: string;
	encodingId?: string;
	running: boolean;
	embedded?: boolean;
}) {
	const { t } = useT();
	const allowed = useMutationAccess("live.aisa.ingest");
	const path = "/api/live/analyses/[analysisId]/ingest".replace(
		"[analysisId]",
		encodeURIComponent(analysisId),
	);
	const ingest = useQuery({
		queryKey: ["aisa-live-ingest", accountId, analysisId, encodingId, allowed],
		queryFn: () =>
			apiFetch<AisaIngest>(
				`${path}?bitmovinAccountId=${encodeURIComponent(accountId)}${encodingId ? `&encodingId=${encodeURIComponent(encodingId)}` : ""}`,
			),
		enabled: allowed && running,
		gcTime: 0,
		retry: false,
		refetchInterval: running ? 5000 : false,
	});
	if (!allowed) return null;
	const rtmp = running ? ingest.data?.rtmpIngest : undefined;
	const srt = running ? ingest.data?.srtIngest : undefined;
	return (
		<section
			className={
				embedded
					? "space-y-3"
					: "space-y-3 rounded-md border border-zinc-800 p-4"
			}
		>
			{!embedded ? (
				<h2 className="font-medium text-zinc-200">{t("aisaLive.ingest")}</h2>
			) : null}
			{ingest.isError ? (
				<p role="alert" className="text-sm text-red-300">
					{t("aisaLive.requestFailed")}
				</p>
			) : null}
			{rtmp ? (
				<div className="space-y-2">
					<p className="break-all font-mono text-sm text-zinc-200">{`rtmp://${rtmp.encoderIp}/${rtmp.application || "live"}`}</p>
					<p className="text-sm text-zinc-400">
						{t("aisaLive.streamKey")}:{" "}
						<CopyableId
							value={rtmp.streamKey}
							label={t("aisaLive.streamKey")}
						/>
					</p>
				</div>
			) : null}
			{srt ? (
				<p className="break-all font-mono text-sm text-zinc-200">{`srt://${srt.encoderIp}:${srt.port}?mode=caller`}</p>
			) : null}
			{!rtmp && !srt ? (
				<p role="status" className="text-sm text-zinc-400">
					{t("aisaLive.ingestWaiting")}
				</p>
			) : null}
			<p className="text-xs text-zinc-500">{t("aisaLive.ingestHint")}</p>
		</section>
	);
}
