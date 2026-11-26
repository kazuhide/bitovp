"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import { MoqPlayerPreview } from "./moq-player-preview";

export function MoqStandalone({
	channelId,
	runId,
}: {
	channelId: string;
	runId: string;
}) {
	const { t } = useT();
	const active = useQuery({
		queryKey: ["moq-live-run-active", channelId, runId],
		refetchInterval: 5000,
		queryFn: async () => {
			const row = await apiFetch<{
				name?: string;
				status?: string;
				currentRun?: { id?: string; status?: string };
			}>(`/api/live-channels/${channelId}`);
			return {
				name: typeof row.name === "string" ? row.name : null,
				isCurrent:
					row.status === "RUNNING" &&
					row.currentRun?.id === runId &&
					row.currentRun.status === "RUNNING",
			};
		},
	});
	return (
		<section className="mx-auto min-w-0 max-w-7xl space-y-4">
			<header className="min-w-0 space-y-1">
				<Link
					href={`/live/${channelId}`}
					className="inline-flex min-h-7 items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200"
				>
					<ArrowLeft aria-hidden className="size-3.5" />
					{t("moqPlayback.backToChannel")}
				</Link>
				<h1 className="break-words font-semibold text-xl text-zinc-100">
					{t("moqPlayback.title")}
				</h1>
				{active.data?.name ? (
					<p className="break-words text-sm text-zinc-400">
						{active.data.name}
					</p>
				) : null}
			</header>
			{active.isPending ? (
				<p role="status" className="text-sm text-zinc-400">
					{t("moqPlayback.loading")}
				</p>
			) : active.isError ? (
				<p role="alert" className="text-sm text-zinc-400">
					{t("moqPlayback.unavailable")}
				</p>
			) : null}
			<MoqPlayerPreview
				channelId={channelId}
				runId={runId}
				active={active.data?.isCurrent === true}
				standalone
			/>
		</section>
	);
}
