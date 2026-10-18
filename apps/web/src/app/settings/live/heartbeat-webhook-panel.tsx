"use client";

import type { LiveHeartbeatSettings, LiveHeartbeatSource } from "@bitovp/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { Input } from "@/components/ui/input";
import { ApiError, apiFetch } from "@/lib/api";
import { RoleAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";

/** Per-encoding heartbeat cadence; idleMinutes is retained only for API compatibility. */
export type LiveHeartbeatSettingsView = {
	effective: LiveHeartbeatSettings;
	source: LiveHeartbeatSource;
	stored: LiveHeartbeatSettings | null;
	/** A row exists, parseable or not — what DELETE would remove. */
	hasRow: boolean;
	envDefault: LiveHeartbeatSettings;
	envSource: Exclude<LiveHeartbeatSource, "gui">;
	bounds: {
		minIntervalS: number;
		maxIntervalS: number;
		maxIdleMinutes: number;
	};
};

const QUERY_KEY = ["live-heartbeat-settings"] as const;
const ENDPOINT = "/api/settings/live-heartbeat";

function wholeNumber(raw: string): number | null {
	const trimmed = raw.trim();
	if (!/^\d+$/.test(trimmed)) {
		return null;
	}
	return Number(trimmed);
}

/** Mirror of the core schema, so the form disables Save before a 400. */
export function parseHeartbeatForm(
	intervalRaw: string,

	bounds: LiveHeartbeatSettingsView["bounds"],
): Pick<LiveHeartbeatSettings, "intervalS"> | null {
	const intervalS = wholeNumber(intervalRaw);
	if (intervalS === null) {
		return null;
	}
	if (
		intervalS !== 0 &&
		(intervalS < bounds.minIntervalS || intervalS > bounds.maxIntervalS)
	) {
		return null;
	}
	return { intervalS };
}

export function HeartbeatWebhookPanel() {
	const { t } = useT();
	const queryClient = useQueryClient();
	const settings = useQuery({
		queryKey: QUERY_KEY,
		queryFn: () => apiFetch<LiveHeartbeatSettingsView>(ENDPOINT),
	});
	const [intervalS, setIntervalS] = useState("");
	const [notice, setNotice] = useState<string | null>(null);
	const loaded = settings.data;
	useEffect(() => {
		if (loaded) {
			setIntervalS(String(loaded.effective.intervalS));
		}
	}, [loaded]);

	const save = useMutation({
		mutationFn: (body: LiveHeartbeatSettings) =>
			apiFetch<LiveHeartbeatSettingsView>(ENDPOINT, {
				method: "PUT",
				body: JSON.stringify(body),
			}),
		onSuccess: (data) => {
			queryClient.setQueryData(QUERY_KEY, data);
			setNotice(t("heartbeatWebhook.saved"));
		},
	});
	const reset = useMutation({
		mutationFn: () =>
			apiFetch<LiveHeartbeatSettingsView>(ENDPOINT, { method: "DELETE" }),
		onSuccess: (data) => {
			queryClient.setQueryData(QUERY_KEY, data);
			setNotice(t("heartbeatWebhook.resetDone"));
		},
	});

	const sourceLabel = (source: LiveHeartbeatSource) =>
		source === "gui"
			? t("heartbeatWebhook.sourceGui")
			: source === "env"
				? t("heartbeatWebhook.sourceEnv")
				: t("heartbeatWebhook.sourceDefault");
	const parsed = loaded ? parseHeartbeatForm(intervalS, loaded.bounds) : null;
	const mutationError = save.error ?? reset.error;

	return (
		<section aria-labelledby="hb-cadence-title">
			<div className="flex items-center gap-2">
				<h2
					id="hb-cadence-title"
					className="font-semibold text-lg text-zinc-100"
				>
					{t("heartbeatWebhook.title")}
				</h2>
				<HelpOverlay labelFor={t("heartbeatWebhook.title")}>
					{t("heartbeatWebhook.intro")}
				</HelpOverlay>
			</div>

			{settings.isLoading ? (
				<div
					role="status"
					aria-busy="true"
					className="mt-4 h-24 max-w-2xl animate-pulse rounded-md bg-zinc-900"
				/>
			) : settings.isError || !loaded ? (
				<div
					role="alert"
					className="mt-4 rounded-md border border-red-900 bg-red-950/30 p-4 text-red-300 text-sm"
				>
					{t("heartbeatWebhook.loadFailed")}
					{settings.error instanceof ApiError
						? `: ${settings.error.message}`
						: ""}
					<Button
						variant="secondary"
						size="sm"
						disabled={settings.isFetching}
						onClick={() => settings.refetch()}
					>
						{t("settingsForms.retry")}
					</Button>
				</div>
			) : (
				<div className="mt-4 max-w-2xl space-y-4">
					<p className="text-sm text-zinc-200" data-testid="hb-effective">
						{loaded.effective.intervalS === 0
							? t("heartbeatWebhook.effectiveOff", {
									source: sourceLabel(loaded.source),
								})
							: t("heartbeatWebhook.effective", {
									interval: String(loaded.effective.intervalS),
									source: sourceLabel(loaded.source),
								})}
					</p>
					<p className="text-xs text-zinc-500" data-testid="hb-env-default">
						{loaded.envSource === "env"
							? loaded.envDefault.intervalS === 0
								? t("heartbeatWebhook.envDefaultOff")
								: t("heartbeatWebhook.envDefault", {
										interval: String(loaded.envDefault.intervalS),
									})
							: t("heartbeatWebhook.codeDefault", {
									interval: String(loaded.envDefault.intervalS),
								})}
					</p>

					<RoleAccess control="settings.live.heartbeat-webhook">
						<form
							className="space-y-3"
							onSubmit={(event) => {
								event.preventDefault();
								if (parsed) {
									setNotice(null);
									reset.reset(); // a stale revert error must not sit beside this save
									save.mutate({
										...parsed,
										mode: "PER_ENCODING",
										idleMinutes: loaded.effective.idleMinutes,
									});
								}
							}}
						>
							<div className="grid gap-3 sm:grid-cols-2">
								<Field
									label={t("heartbeatWebhook.intervalLabel")}
									htmlFor="hb-interval"
									help={t("heartbeatWebhook.intervalHint", {
										max: String(loaded.bounds.maxIntervalS),
									})}
								>
									<Input
										id="hb-interval"
										inputMode="numeric"
										value={intervalS}
										disabled={save.isPending || reset.isPending}
										onChange={(e) => {
											setIntervalS(e.target.value);
											setNotice(null);
										}}
									/>
								</Field>
							</div>
							{parsed === null ? (
								<p className="text-amber-300 text-xs" role="alert">
									{t("heartbeatWebhook.invalid", {
										maxInterval: String(loaded.bounds.maxIntervalS),
									})}
								</p>
							) : null}
							<div className="flex flex-wrap gap-2">
								<Button
									type="submit"
									disabled={
										parsed === null || save.isPending || reset.isPending
									}
								>
									{t("heartbeatWebhook.save")}
								</Button>
								<Button
									type="button"
									variant="secondary"
									disabled={!loaded.hasRow || reset.isPending || save.isPending}
									onClick={() => {
										setNotice(null);
										save.reset(); // likewise for a stale save error
										reset.mutate();
									}}
								>
									{t("heartbeatWebhook.reset")}
								</Button>
							</div>
						</form>
					</RoleAccess>

					{notice ? (
						<p className="text-emerald-300 text-sm" role="status">
							{notice}
						</p>
					) : null}
					{mutationError ? (
						<p
							role="alert"
							className="rounded-md border border-red-900 bg-red-950/30 p-3 text-red-300 text-sm"
						>
							{mutationError instanceof ApiError
								? mutationError.message
								: String(mutationError)}
						</p>
					) : null}
				</div>
			)}
		</section>
	);
}
