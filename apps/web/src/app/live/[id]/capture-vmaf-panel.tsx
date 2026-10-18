"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FeederSessionListItem } from "@/app/live/feeders/feeder-shared";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { localizedCustomerError } from "@/lib/customer-error";
import { useT } from "@/lib/i18n/context";

/**
 * t("captureVmaf.capture") action on a pseudo-live channel detail (P4-PR6b). Creates a
 * LIVE VmafJob that captures the recent output window, aligns it against the
 * looping feeder source (PR6a engine), and scores it with libvmaf — then links
 * straight to the /qc/[id] report. Shown only when the channel is RUNNING AND
 * has an attached feeder session (the looping source is the reference); the
 * route re-enforces both, so a lost race still 409s and surfaces verbatim.
 */
export function CaptureVmafPanel({
	channelId,
	channelStatus,
}: {
	channelId: string;
	channelStatus: string;
}) {
	const { t } = useT();
	const router = useRouter();
	const [windowSeconds, setWindowSeconds] = useState("120");
	const [error, setError] = useState<string | null>(null);
	const duration = Number(windowSeconds);
	const validWindow =
		windowSeconds.trim() !== "" &&
		Number.isInteger(duration) &&
		duration >= 10 &&
		duration <= 600;

	// Reuse the channel's feeder-session list (the FeederPanel already polls the
	// same key, so this shares its cache) to decide pseudo-live eligibility.
	const sessions = useQuery({
		queryKey: ["feeder-sessions", channelId],
		queryFn: () =>
			apiFetch<{ items: FeederSessionListItem[] }>(
				`/api/feeder-sessions?liveChannelId=${encodeURIComponent(channelId)}`,
			),
	});
	const hasFeeder = (sessions.data?.items ?? []).some((s) =>
		["PUSHING", "DOWNLOADING", "STOPPED"].includes(s.status),
	);

	const capture = useMutation({
		mutationFn: () =>
			apiFetch<{ id: string }>(`/api/live-channels/${channelId}/capture-vmaf`, {
				method: "POST",
				body: JSON.stringify({ windowSeconds: Number(windowSeconds) }),
			}),
		onMutate: () => setError(null),
		onSuccess: (data) => {
			router.push(`/qc/${data.id}`);
		},
		onError: (err) => {
			setError(localizedCustomerError(t, err, "captureVmaf.failed"));
		},
	});

	if (channelStatus !== "RUNNING") {
		return (
			<p className="mt-2 text-xs text-zinc-500">
				{t("captureVmaf.needsRunning")}
			</p>
		);
	}

	return (
		<div className="mt-2 space-y-3">
			{sessions.isPending ? (
				<p role="status" className="text-xs text-zinc-500">
					{t("common.loading")}
				</p>
			) : sessions.isError ? (
				<div role="alert" className="text-xs text-red-400">
					{t("feeder.loadFailed")}{" "}
					<Button
						size="sm"
						variant="secondary"
						disabled={sessions.isFetching}
						onClick={() => sessions.refetch()}
					>
						{t("common.retry")}
					</Button>
				</div>
			) : !hasFeeder ? (
				<p role="alert" className="text-amber-400 text-xs">
					{t("prose.captureVmafNoFeeder")}
				</p>
			) : null}
			{/* w-64 (schedule-panel's cap-row pattern): Field's trailing row is
			    flex-1, so an unconstrained Field spans the panel and flings the
			    button to the far right (review-231 I1). */}
			<div className="w-64">
				<Field
					label={t("captureVmaf.window")}
					htmlFor="vmaf-window"
					help={t("ui.mostRecentOutputSegmentsToAlign10")}
					trailing={
						<Button
							size="sm"
							disabled={
								capture.isPending ||
								!hasFeeder ||
								sessions.isPending ||
								sessions.isError ||
								!validWindow
							}
							onClick={() => capture.mutate()}
						>
							{capture.isPending
								? t("captureVmaf.starting")
								: t("captureVmaf.capture")}
						</Button>
					}
				>
					<Input
						id="vmaf-window"
						type="number"
						min={10}
						max={600}
						step={1}
						disabled={capture.isPending}
						aria-invalid={!validWindow}
						aria-describedby={!validWindow ? "vmaf-window-error" : undefined}
						value={windowSeconds}
						onChange={(e) => setWindowSeconds(e.target.value)}
					/>
				</Field>
			</div>
			{!validWindow ? (
				<p
					id="vmaf-window-error"
					role="alert"
					className="text-xs text-amber-400"
				>
					{t("captureVmaf.invalidWindow")}
				</p>
			) : null}
			{error ? (
				<p role="alert" className="text-red-400 text-sm">
					{error}
				</p>
			) : null}
		</div>
	);
}
