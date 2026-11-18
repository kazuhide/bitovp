"use client";

import {
	type LiveChannelPlan,
	type PlanRendition,
	renditionFamily,
} from "@bitovp/core";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { formatBitrate } from "@/app/vod/jobs/[id]/rendition-tables";
import { DetailPopover, KeyValueRows } from "@/components/ui/detail-popover";
import { apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";
import type { LiveDiagnosticsResponse } from "@/lib/live-diagnostics/types";

const DIAGNOSTICS_API = "/api/live-channels/[id]/runs/[runId]/diagnostics";
type RunIdentity = { channelId: string; runId: string; encodingId: string };

function heightOf(rendition: PlanRendition): string {
	const h = (rendition as { height?: number }).height;
	return typeof h === "number" ? `${h}p` : "—";
}

function bitrateOf(rendition: PlanRendition): string {
	const b = (rendition as { bitrate?: number }).bitrate;
	return formatBitrate(typeof b === "number" ? b : undefined);
}

function Row({ rendition }: { rendition: PlanRendition }) {
	const { t } = useT();
	return (
		<tr className="border-zinc-800 border-t">
			<td className="px-3 py-1.5 font-mono text-xs text-zinc-300">
				{rendition.key}
			</td>
			<td className="px-3 py-1.5 text-xs text-zinc-400 uppercase">
				{rendition.codec}
			</td>
			<td className="px-3 py-1.5 text-xs text-zinc-300">
				{heightOf(rendition)}
			</td>
			<td className="px-3 py-1.5 text-xs text-zinc-300">
				{bitrateOf(rendition)}
			</td>
			<td className="px-3 py-1.5 text-xs">
				<DetailPopover
					summary={t("live.ladderParams", {
						count: Object.keys(rendition).length,
					})}
					label={t("live.ladderParamsLabel", { key: rendition.key })}
				>
					<KeyValueRows record={rendition as Record<string, unknown>} />
				</DetailPopover>
			</td>
		</tr>
	);
}

function ConfiguredLadder({ renditions }: { renditions: PlanRendition[] }) {
	const { t } = useT();
	const video = renditions.filter((r) => renditionFamily(r) === "video");
	const audio = renditions.filter((r) => renditionFamily(r) === "audio");
	const other = renditions.filter((r) => renditionFamily(r) === "subtitle");
	const groups: [string, string, PlanRendition[]][] = [
		["video", t("live.ladderVideo"), video],
		["audio", t("live.ladderAudio"), audio],
		...(other.length > 0
			? ([["other", t("live.ladderOther"), other]] as [
					string,
					string,
					PlanRendition[],
				][])
			: []),
	];
	return (
		<div className="space-y-2">
			<h4 className="font-medium text-sm text-zinc-300">
				{t("live.ladderConfigured")}
			</h4>
			{groups.map(([id, label, renditions]) =>
				renditions.length > 0 ? (
					<div key={id}>
						<h5 className="mb-1 text-xs text-zinc-500">{label}</h5>
						<div className="overflow-x-auto rounded-md border border-zinc-800">
							<table className="w-full text-left">
								<thead>
									<tr className="text-xs text-zinc-500">
										<th className="px-3 py-1.5 font-medium">
											{t("live.ladderKey")}
										</th>
										<th className="px-3 py-1.5 font-medium">
											{t("live.ladderCodec")}
										</th>
										<th className="px-3 py-1.5 font-medium">
											{t("live.ladderHeight")}
										</th>
										<th className="px-3 py-1.5 font-medium">
											{t("live.ladderBitrate")}
										</th>
										<th className="px-3 py-1.5 font-medium">
											{t("live.ladderDetail")}
										</th>
									</tr>
								</thead>
								<tbody>
									{renditions.map((rendition) => (
										<Row key={rendition.key} rendition={rendition} />
									))}
								</tbody>
							</table>
						</div>
					</div>
				) : null,
			)}
		</div>
	);
}

function ObservedLadder({ channelId, runId, encodingId }: RunIdentity) {
	const { t } = useT();
	const heading = useId();
	const canRead = useMutationAccess("live.channel.heartbeat-log");
	const query = useQuery({
		queryKey: ["live-run-ladder", channelId, runId, encodingId],
		queryFn: async ({ signal }) => {
			const path = DIAGNOSTICS_API.replace("[id]", channelId).replace(
				"[runId]",
				runId,
			);
			const result = await apiFetch<LiveDiagnosticsResponse>(
				`${path}?kind=ladder`,
				{ signal },
			);
			if (
				result.kind !== "ladder" ||
				result.runId !== runId ||
				result.encodingId !== encodingId
			)
				throw new Error("Unexpected live run ladder response");
			return result.data;
		},
		enabled: canRead,
		retry: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});
	if (!canRead) return null;
	const message = query.isPending
		? t("heartbeatLog.loading")
		: query.isError || !query.data
			? t("live.ladderObservedUnavailable")
			: query.data.length === 0
				? t("live.ladderObservedEmpty")
				: null;
	return (
		<div className="space-y-2">
			<h4 id={heading} className="font-medium text-sm text-zinc-300">
				{t("live.ladderObserved")}
			</h4>
			{message ? (
				<p role="status" className="text-sm text-zinc-500">
					{message}
				</p>
			) : (
				<div className="overflow-x-auto rounded-md border border-zinc-800">
					<table aria-labelledby={heading} className="w-full text-left text-xs">
						<thead>
							<tr className="text-zinc-500">
								{(
									[
										"live.ladderCodec",
										"live.ladderHeight",
										"live.ladderBitrate",
									] as const
								).map((column) => (
									<th
										key={column}
										scope="col"
										className="px-3 py-1.5 font-medium"
									>
										{t(column)}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{query.data?.map((row) => (
								<tr
									key={row.streamId}
									className="border-zinc-800 border-t text-zinc-300"
								>
									<td className="px-3 py-1.5">{row.codec ?? "—"}</td>
									<td className="px-3 py-1.5">
										{row.height === undefined ? "—" : `${row.height}p`}
									</td>
									<td className="px-3 py-1.5">{formatBitrate(row.bitrate)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}

export function LadderPanel({
	plan,
	run,
	open,
}: {
	plan?: LiveChannelPlan;
	run?: RunIdentity | null;
	open?: boolean;
}) {
	const { t } = useT();
	return (
		<div className="space-y-3">
			{plan?.renditions.length ? (
				<ConfiguredLadder renditions={plan.renditions} />
			) : (
				<div className="space-y-1">
					<h4 className="font-medium text-sm text-zinc-300">
						{t("live.ladderConfigured")}
					</h4>
					<p className="text-sm text-zinc-500">
						{t(plan ? "live.ladderConfiguredUnavailable" : "status.unknown")}
					</p>
				</div>
			)}
			{run && open ? <ObservedLadder {...run} /> : null}
		</div>
	);
}
