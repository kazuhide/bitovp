"use client";

import { useQuery } from "@tanstack/react-query";
import {
	CartesianGrid,
	Line,
	LineChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import { moqAnalyticsReadbackSchema } from "@/lib/moq-player/analytics-readback";

const clock = (value: number) =>
	Number.isFinite(value) ? new Date(value).toISOString().slice(11, 19) : "—";

export function MoqAnalyticsHistory({
	channelId,
	runId,
	encodingId,
	impressionId,
	active,
}: {
	channelId: string;
	runId: string;
	encodingId: string;
	impressionId: string;
	active: boolean;
}) {
	const { t } = useT();
	const query = useQuery({
		queryKey: ["moq-analytics", channelId, runId, impressionId],
		queryFn: async () => {
			const value = moqAnalyticsReadbackSchema.parse(
				await apiFetch(
					`/api/live-channels/${channelId}/runs/${runId}/moq-analytics?impressionId=${encodeURIComponent(impressionId)}`,
					{ cache: "no-store" },
				),
			);
			if (
				value.runId !== runId ||
				value.encodingId !== encodingId ||
				value.impressionId !== impressionId ||
				value.videoId !== `bitovp-moq:${encodingId}:${runId}`
			)
				throw new Error("MoQ Analytics unavailable");
			return value;
		},
		refetchInterval: active ? 5000 : false,
	});
	const series =
		query.data?.points.map((point) => ({
			...point,
			timestamp: Date.parse(point.observedAt),
		})) ?? [];
	return (
		<section
			data-moq-analytics={impressionId}
			data-state={query.isError ? "error" : (query.data?.status ?? "loading")}
			className="space-y-2 border-t border-zinc-800 pt-3"
		>
			<div className="flex items-center justify-between gap-2">
				<h4 className="font-medium text-sm text-zinc-200">
					{t("moqAnalytics.title")}
				</h4>
				<button
					type="button"
					disabled={query.isFetching}
					onClick={() => {
						void query.refetch();
					}}
					className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
				>
					{t("providerDiagnostics.refresh")}
				</button>
			</div>
			<p className="text-xs text-zinc-500">{t("moqAnalytics.source")}</p>
			{query.isPending ? (
				<p className="text-xs text-zinc-500">{t("moqPlayback.loading")}</p>
			) : query.isError ? (
				<p className="text-xs text-zinc-500">{t("moqAnalytics.unavailable")}</p>
			) : !series.length ? (
				<p className="text-xs text-zinc-500">{t("moqAnalytics.pending")}</p>
			) : (
				<>
					<p className="text-xs text-zinc-400">
						{t("moqAnalytics.received", { count: series.length })}
					</p>
					<figure>
						<figcaption className="mb-1 text-xs text-zinc-400">
							{t("moqPlayback.latency")} (ms · UTC)
						</figcaption>
						<div className="h-36 w-full">
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
										width={42}
										stroke="var(--color-zinc-500)"
										tick={{ fontSize: 10 }}
									/>
									<Tooltip
										labelFormatter={(value) => clock(Number(value))}
										contentStyle={{
											background: "var(--color-zinc-950)",
											borderColor: "var(--color-zinc-700)",
											color: "var(--color-zinc-200)",
										}}
									/>
									<Line
										dataKey="latencyMs"
										name={t("moqPlayback.latency")}
										unit=" ms"
										connectNulls={false}
										dot={false}
										isAnimationActive={false}
										stroke="var(--color-sky-400)"
									/>
								</LineChart>
							</ResponsiveContainer>
						</div>
					</figure>
					{query.data?.truncated ? (
						<p className="text-xs text-zinc-500">{t("moqEncoder.truncated")}</p>
					) : null}
				</>
			)}
		</section>
	);
}
