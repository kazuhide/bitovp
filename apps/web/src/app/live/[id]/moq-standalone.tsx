"use client";

import { useQuery } from "@tanstack/react-query";
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
				status?: string;
				currentRun?: { id?: string; status?: string };
			}>(`/api/live-channels/${channelId}`);
			return (
				row.status === "RUNNING" &&
				row.currentRun?.id === runId &&
				row.currentRun.status === "RUNNING"
			);
		},
	});
	return (
		<section className="mx-auto max-w-3xl space-y-3">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h1 className="font-semibold text-xl text-zinc-100">
					{t("moqPlayback.title")}
				</h1>
				<Link
					href={`/live/${channelId}`}
					className="text-sm text-zinc-300 underline underline-offset-2"
				>
					{t("moqPlayback.backToChannel")}
				</Link>
			</div>
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
				active={active.data === true}
				standalone
			/>
		</section>
	);
}
