"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
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
import { buildHeartbeatCorrelationUrl } from "./heartbeat-correlation";
import { MoqAnalyticsHistory } from "./moq-analytics-history";

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
	const canvasRates = Boolean(
		session?.samples.length &&
			session.samples.every((sample) => sample.renderingSource === "canvas"),
	);
	const videoRates = Boolean(
		session?.samples.length &&
			session.samples.every((sample) => sample.renderingSource === "video"),
	);
	let archiveUrl: string | null = null;
	try {
		if (session && organizationId)
			archiveUrl = bindPassiveRequestUrl(
				`${moqObservationPath(channelId, runId)}/${session.id}/archive`,
				organizationId,
			);
	} catch {
		/* Never emit a bare native URL without its document binding. */
	}
	const analyticsEncodingId = session?.analyticsVideoId?.split(":")[1];
	const correlationTo = session
		? (session.endedAt ??
			new Date(
				Date.parse(session.startedAt) +
					Math.max(
						0,
						...session.samples.map((sample) => sample.elapsedMs),
						...session.events.map((event) => event.elapsedMs),
					),
			).toISOString())
		: undefined;
	const correlationUrl =
		session && correlationTo
			? buildHeartbeatCorrelationUrl(
					channelId,
					runId,
					session.startedAt,
					correlationTo,
				)
			: null;
	const chart = (
		field: "latencyMs" | "fps" | "bufferSeconds",
		label: string,
		unit: string,
	) =>
		series.some((point) => point[field] !== null) ? (
			<figure data-moq-chart={field} className="min-w-0">
				<figcaption className="mb-1 text-xs text-zinc-400">
					{label} ({unit} · UTC)
				</figcaption>
				<div className="h-28 w-full">
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
									`${clock(Number(value))} UTC · +${((Number(value) - Date.parse(session?.startedAt ?? "")) / 1000).toFixed(1)}s`
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
								dot={
									series.filter((point) => point[field] !== null).length === 1
										? { r: 3 }
										: false
								}
								isAnimationActive={false}
								stroke="var(--color-emerald-400)"
							/>
						</LineChart>
					</ResponsiveContainer>
				</div>
			</figure>
		) : null;
	const secondary = chart(
		"fps",
		t(
			canvasRates
				? "moqPlayback.canvasUpdates"
				: videoRates
					? "moqPlayback.fps"
					: "moqPlayback.frameHistory",
		),
		videoRates ? "fps" : "/s",
	);
	const buffer = chart("bufferSeconds", t("moqPlayback.bufferHistory"), "s");
	const latency = chart("latencyMs", t("moqPlayback.latency"), "ms");
	return (
		<section
			data-moq-history={runId}
			className="space-y-2 border-t border-zinc-800 pt-3"
		>
			<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
				<h3 className="font-medium text-sm text-zinc-200">
					{t("moqPlayback.savedHistory")}
				</h3>
				{correlationUrl ? (
					<Link
						data-moq-encoder-correlation
						data-moq-correlate-run={runId}
						data-moq-correlate-start={session?.startedAt}
						data-moq-correlate-end={correlationTo}
						href={correlationUrl}
						title={runId}
						className="text-xs text-zinc-400 underline underline-offset-2"
					>
						{t("moqPlayback.encoderCorrelation")}
					</Link>
				) : null}
			</div>
			{history.isPending ? (
				<p className="text-xs text-zinc-500">{t("moqPlayback.loading")}</p>
			) : history.isError ? (
				<p className="text-xs text-red-300">{t("moqPlayback.historyFailed")}</p>
			) : !session ? (
				<p className="text-xs text-zinc-500">{t("moqPlayback.noHistory")}</p>
			) : (
				<>
					{sessions.length > 1 ? (
						<label className="flex max-w-sm flex-col gap-1 text-xs text-zinc-400">
							{t("moqPlayback.observationSession")}
							<select
								value={session.id}
								onChange={(event) => select(event.target.value)}
								className="h-8 rounded border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-200"
							>
								{sessions.map((value) => (
									<option key={value.id} value={value.id}>
										{value.startedAt}
									</option>
								))}
							</select>
						</label>
					) : null}
					<p className="text-xs text-zinc-500">
						{session.startedAt.slice(0, 10)}{" "}
						<time dateTime={session.startedAt}>
							{clock(Date.parse(session.startedAt))}
						</time>
						{session.endedAt ? (
							<>
								{" "}
								–{" "}
								<time dateTime={session.endedAt}>
									{clock(Date.parse(session.endedAt))}
								</time>
							</>
						) : null}{" "}
						UTC
					</p>
					{session.archive && archiveUrl ? (
						<div className="max-w-2xl space-y-1">
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
								className="inline-block text-xs text-zinc-300 underline underline-offset-2"
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
					{series.length ? (
						(latency ?? (
							<p className="text-xs text-zinc-500">
								{t("moqPlayback.latency")} ·{" "}
								<span>{t("moqPlayback.unmeasured")}</span>
							</p>
						))
					) : (
						<p className="text-xs text-zinc-500">
							{t("moqPlayback.noSamples")}
						</p>
					)}
					{session.samples.length ||
					session.events.length ||
					session.analyticsImpressionId ? (
						<details>
							<summary className="cursor-pointer text-xs text-zinc-400">
								{t("moqPlayback.moreObservations")}
							</summary>
							<div className="mt-2 space-y-3">
								<p className="text-xs text-zinc-500">
									{t("moqPlayback.browserSource")} ·{" "}
									<span>
										{canvasRates
											? t("moqPlayback.renderingCanvas")
											: videoRates
												? t("moqPlayback.renderingVideo")
												: t("moqPlayback.frameHistory")}
									</span>
								</p>
								{canvasRates ? (
									<p className="text-xs text-zinc-500">
										{t("moqPlayback.canvasMeasurement")}
									</p>
								) : null}
								<p className="text-xs text-zinc-500">
									{t("moqPlayback.historyClock")}
								</p>
								<p className="text-xs text-zinc-500">
									{t("moqPlayback.recordedScope")}
								</p>
								<p className="break-all font-mono text-[11px] text-zinc-500">
									{runId}
								</p>
								{secondary}
								{buffer}
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
								{session.analyticsImpressionId && analyticsEncodingId ? (
									<MoqAnalyticsHistory
										channelId={channelId}
										runId={runId}
										encodingId={analyticsEncodingId}
										impressionId={session.analyticsImpressionId}
										active={active}
									/>
								) : null}
							</div>
						</details>
					) : null}
				</>
			)}
			{history.data?.configuration ? (
				<details>
					<summary className="cursor-pointer text-xs text-zinc-400">
						{t("moqPlayback.configuration")}
					</summary>
					<dl className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-xs">
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
				</details>
			) : null}
		</section>
	);
}
