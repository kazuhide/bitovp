"use client";

import { useId } from "react";
import { formatDateTime } from "@/lib/format";
import type { MessageKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/context";
import type { HeartbeatReception } from "../live-shared";
import { videoStream } from "./delivery-status";
import { incomingMbps, parseHeartbeat } from "./heartbeat";
import {
	heartbeatReceptionView,
	type ReceptionSampleState,
	type ReceptionState,
} from "./heartbeat-reception";

const STATE_COPY: Record<ReceptionState, MessageKey> = {
	unavailable: "live.push.unavailable",
	never: "live.push.never",
	fresh: "live.push.receiving",
	stale: "live.push.stale",
	"clock-skew": "live.push.clockSkew",
	ended: "live.push.ended",
};
const SAMPLE_COPY: Record<ReceptionSampleState, MessageKey> = {
	fresh: "live.push.sampleFresh",
	stale: "live.push.sampleStale",
	unknown: "live.push.sampleUnknown",
	"clock-skew": "live.push.sampleSkew",
	historical: "live.push.sampleHistorical",
};

/** Optional receipt details, not a second health dashboard. */
export function HeartbeatReceptionPanel({
	reception,
	runId,
	nowMs,
	mode,
}: {
	reception: HeartbeatReception | undefined;
	runId: string | null;
	nowMs: number;
	mode: "live" | "finished";
}) {
	const { t } = useT();
	const heading = useId();
	const view = heartbeatReceptionView(reception, runId, nowMs, mode);
	const registration =
		reception?.state === "available" && reception.runId === runId
			? reception.registration
			: undefined;
	const sample = view.latest
		? parseHeartbeat({
				at: view.latest.sampledAt,
				raw: view.latest.raw,
				deltas: {},
			})
		: null;
	const video = videoStream(sample);
	const stamp = (value: string | null) =>
		value && Number.isFinite(Date.parse(value)) ? formatDateTime(value) : "—";
	const warn = view.state === "stale" || view.state === "clock-skew";
	const metrics: [string, string][] = view.latest
		? [
				[t("live.push.receivedAt"), stamp(view.latest.receivedAt)],
				[t("live.push.sampledAt"), stamp(view.latest.sampledAt)],
				[
					t("live.push.observedCadence"),
					view.cadenceSeconds === null
						? "—"
						: t("live.health.seconds", { s: view.cadenceSeconds.toFixed(1) }),
				],
				[
					t("live.push.configuredCadence"),
					view.configuredIntervalS === null
						? "—"
						: view.configuredIntervalS === 0
							? t("live.push.off")
							: t("live.health.seconds", { s: view.configuredIntervalS }),
				],
				[t("live.push.sampleInput"), sample?.ingestStatus ?? "—"],
				[
					t("heartbeatLog.incomingMbps"),
					video?.incomingBitrate == null
						? "—"
						: `${incomingMbps(video.incomingBitrate)} Mbps`,
				],
			]
		: [];
	return (
		<details
			aria-labelledby={heading}
			className="rounded-md border border-zinc-800 bg-zinc-900/30 p-3"
		>
			<summary className="cursor-pointer">
				<h3 id={heading} className="font-medium text-sm text-zinc-200">
					{t("live.push.title")}
				</h3>
				<p className={`text-sm ${warn ? "text-amber-300" : "text-zinc-300"}`}>
					{t(STATE_COPY[view.state])}
				</p>
			</summary>
			<p className="mt-1 text-xs text-zinc-400">{t("live.push.boundary")}</p>
			{registration ? (
				<dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
					<div>
						<dt className="text-xs text-zinc-400">
							{t("heartbeatWebhook.modeLabel")}
						</dt>
						<dd>
							{t(
								registration.mode === "PER_ENCODING"
									? "live.push.perEncoding"
									: registration.mode === "LEGACY_ACCOUNT"
										? "heartbeatWebhook.modeLegacy"
										: registration.mode === "POLL_ONLY"
											? "live.push.pollOnly"
											: "live.push.pendingVersion",
							)}
						</dd>
					</div>
					<div>
						<dt className="text-xs text-zinc-400">
							{t("live.push.actualVersion")}
						</dt>
						<dd>{registration.resolvedEncoderVersion ?? "—"}</dd>
					</div>
					<div>
						<dt className="text-xs text-zinc-400">
							{t("live.push.registration")}
						</dt>
						<dd>
							{t(
								registration.status === "ACTIVE"
									? "live.push.registered"
									: registration.status === "DELETED"
										? "live.push.retired"
										: "live.push.notRegistered",
							)}
						</dd>
					</div>
				</dl>
			) : null}
			{view.latest ? (
				<>
					<dl className="mt-3 grid gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
						{metrics.map(([label, value]) => (
							<div key={label} className="min-w-0">
								<dt className="text-xs text-zinc-400">{label}</dt>
								<dd className="mt-0.5 break-words text-sm text-zinc-200">
									{value}
								</dd>
							</div>
						))}
					</dl>
					<p
						className={`mt-2 text-xs ${view.sampleState === "stale" || view.sampleState === "clock-skew" ? "text-amber-300" : "text-zinc-400"}`}
					>
						{t(SAMPLE_COPY[view.sampleState])}
					</p>
				</>
			) : null}
		</details>
	);
}
