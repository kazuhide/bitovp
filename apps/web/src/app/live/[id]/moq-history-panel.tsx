"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
	CartesianGrid,
	Line,
	LineChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { useDocumentOrganization } from "@/components/providers";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import { moqObservationPath } from "@/lib/moq-player/history-client";
import { moqHistorySeries } from "@/lib/moq-player/history-series";
import { moqObservationHistorySchema } from "@/lib/moq-player/observations";
import { bindPassiveRequestUrl } from "@/lib/passive-request";
import { MoqAnalyticsHistory } from "./moq-analytics-history";
import { MoqEncoderHistory } from "./moq-encoder-history";

const clock = (value: number) =>
	Number.isFinite(value) ? new Date(value).toISOString().slice(11, 19) : "—";

export function MoqHistoryPanel({
	channelId,
	runId,
	active,
}: {
	channelId: string;
	runId: string;
	active: boolean;
}) {
	const { t } = useT();
	const organizationId = useDocumentOrganization();
	const [selected, select] = useState("");
	const history = useQuery({
		queryKey: ["moq-observations", channelId, runId],
		queryFn: async () => {
			const value = moqObservationHistorySchema.parse(
				await apiFetch(moqObservationPath(channelId, runId), {
					cache: "no-store",
				}),
			);
			if (value.runId !== runId) throw new Error();
			return value;
		},
		refetchInterval: active ? 5000 : false,
	});
	const sessions = [...(history.data?.sessions ?? [])].sort(
		(a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt),
	);
	const session =
		sessions.find((value) => value.id === selected) ?? sessions[0];
	const series = moqHistorySeries(
		session?.samples ?? [],
		session?.startedAt ?? "",
	);
	let archiveUrl: string | null = null;
	try {
		if (session && organizationId)
			archiveUrl = bindPassiveRequestUrl(
				`${moqObservationPath(channelId, runId)}/${session.id}/archive`,
				organizationId,
			);
	} catch {
		/* A missing document binding never becomes a bare native URL. */
	}
	const analyticsEncodingId = session?.analyticsVideoId?.split(":")[1];
	return (
		<section
			data-moq-history={runId}
			className="@container space-y-3 border-t border-zinc-800 pt-3"
		>
			<h3 className="font-medium text-sm text-zinc-200">
				{t("moqPlayback.savedHistory")}
			</h3>
			{history.data?.configuration ? (
				<dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
					<div className="min-w-0">
						<dt className="text-zinc-500">{t("moqPlayback.namespace")}</dt>
						<dd className="break-words text-zinc-200">
							{history.data.configuration.namespace.join("/")}
						</dd>
					</div>
					<div>
						<dt className="text-zinc-500">{t("moqPlayback.draft")}</dt>
						<dd className="text-zinc-200">
							{history.data.configuration.draftVersion}
						</dd>
					</div>
					<div>
						<dt className="text-zinc-500">{t("moqPlayback.catalog")}</dt>
						<dd className="text-zinc-200">
							{history.data.configuration.catalogTrackName}
						</dd>
					</div>
				</dl>
			) : null}
			{history.isPending ? (
				<p className="text-xs text-zinc-500">{t("moqPlayback.loading")}</p>
			) : history.isError ? (
				<p className="text-xs text-red-300">{t("moqPlayback.historyFailed")}</p>
			) : !session ? (
				<p className="text-xs text-zinc-500">{t("moqPlayback.noHistory")}</p>
			) : (
				<>
					<label className="flex flex-col gap-1 text-xs text-zinc-400">
						{t("moqPlayback.observationSession")}
						<select
							value={session.id}
							onChange={(event) => select(event.target.value)}
							className="h-8 max-w-full rounded border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-200"
						>
							{sessions.map((value) => (
								<option key={value.id} value={value.id}>
									{value.startedAt}
								</option>
							))}
						</select>
					</label>
					<p className="text-xs text-zinc-500">
						{t("moqPlayback.recordedScope")}
					</p>
					{session.archive && archiveUrl ? (
						<div className="space-y-2">
							<video
								data-moq-archive={session.id}
								src={archiveUrl}
								controls
								muted
								playsInline
								preload="metadata"
								aria-label={t("moqPlayback.receivedVideo")}
								className="aspect-video w-full rounded border border-zinc-800 bg-black"
							/>
							<a
								href={archiveUrl}
								download={`moq-${session.id}.webm`}
								className="text-xs text-zinc-300 underline underline-offset-2"
							>
								{t("moqPlayback.downloadRecording")}
							</a>
						</div>
					) : (
						<p className="text-xs text-zinc-500">
							{t(
								session.archive
									? "moqPlayback.unavailable"
									: "moqPlayback.noRecording",
							)}
						</p>
					)}
					<p className="text-xs text-zinc-500">
						{t("moqPlayback.browserSource")}
					</p>
					<p className="text-xs text-zinc-500">
						{t("moqPlayback.historyClock")}
					</p>
					{series.length ? (
						<div className="grid gap-3 @3xl:grid-cols-3">
							{(
								[
									{
										field: "latencyMs",
										label: t("moqPlayback.latency"),
										unit: "ms",
									},
									{ field: "fps", label: t("moqPlayback.fps"), unit: "fps" },
									{
										field: "bufferSeconds",
										label: t("moqPlayback.bufferHistory"),
										unit: "s",
									},
								] as const
							).map(({ field, label, unit }) => (
								<figure key={field} className="min-w-0">
									<figcaption className="mb-1 text-xs text-zinc-400">
										{label} ({unit} · UTC)
									</figcaption>
									<div className="h-32 w-full">
										{series.some((point) => point[field] !== null) ? (
											<ResponsiveContainer width="100%" height="100%">
												<LineChart data={series} accessibilityLayer>
													<CartesianGrid stroke="var(--color-zinc-800)" />
													<XAxis
														dataKey="timestamp"
														type="number"
														domain={["dataMin", "dataMax"]}
														tickFormatter={clock}
														stroke="var(--color-zinc-500)"
														tick={{ fontSize: 10 }}
													/>
													<YAxis
														stroke="var(--color-zinc-500)"
														tick={{ fontSize: 10 }}
														width={42}
													/>
													<Tooltip
														labelFormatter={(value) =>
															`${clock(Number(value))} UTC · +${((Number(value) - Date.parse(session.startedAt)) / 1000).toFixed(1)}s`
														}
														contentStyle={{
															background: "var(--color-zinc-950)",
															borderColor: "var(--color-zinc-700)",
															color: "var(--color-zinc-200)",
														}}
													/>
													<Line
														dataKey={field}
														name={label}
														unit={` ${unit}`}
														type="linear"
														connectNulls={false}
														dot={false}
														isAnimationActive={false}
														stroke="var(--color-emerald-400)"
													/>
												</LineChart>
											</ResponsiveContainer>
										) : (
											<p className="flex h-full items-center text-xs text-zinc-500">
												{t("moqPlayback.unmeasured")}
											</p>
										)}
									</div>
								</figure>
							))}
						</div>
					) : (
						<p className="text-xs text-zinc-500">
							{t("moqPlayback.noSamples")}
						</p>
					)}
					{session.events.length ? (
						<p className="text-xs text-zinc-500">
							{session.events
								.map(
									(event) =>
										`${(event.elapsedMs / 1000).toFixed(1)}s ${t(`moqPlayback.event.${event.type}`)}`,
								)
								.join(" · ")}
						</p>
					) : null}
				</>
			)}
			{history.data ? (
				<MoqEncoderHistory heartbeat={history.data.heartbeat} />
			) : null}
			{session?.analyticsImpressionId && analyticsEncodingId ? (
				<MoqAnalyticsHistory
					channelId={channelId}
					runId={runId}
					encodingId={analyticsEncodingId}
					impressionId={session.analyticsImpressionId}
					active={active}
				/>
			) : null}
		</section>
	);
}
