"use client";

import type { StartupProfile } from "@bitovp/core";
import {
	AGGREGATE_CLOUD_REGIONS,
	type CredentialSummaryWire,
	PROBE_FUSE_MINUTES,
	PROBE_STOP_WAIT_MINUTES,
} from "@bitovp/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { Input, SelectNative } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { RoleAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";

/**
 * Startup-time profiles  — what the passive samples say
 * about how long each region takes to reach RUNNING. Honesty rules render
 * here exactly as core computes them: below PERCENTILE_MIN_N there are no
 * "P50/P90" labels, only max + n + the raw list; failures and censored
 * counts sit beside every number.
 */

type ProfileRow = { region: string; source: string; profile: StartupProfile };

const WINDOWS = [7, 30, 90] as const;

function seconds(value: number | null): string {
	if (value === null) {
		return "—";
	}
	if (value < 90) {
		return `${value}s`;
	}
	const m = Math.floor(value / 60);
	const s = value % 60;
	return s === 0 ? `${m}m` : `${m}m${s}s`;
}

export function StartupProfilesPanel() {
	const { t } = useT();
	const windowId = useId();
	const [windowDays, setWindowDays] = useState<number>(30);

	const profiles = useQuery({
		queryKey: ["startup-profiles", windowDays],
		queryFn: () =>
			apiFetch<{ windowDays: number; rows: ProfileRow[] }>(
				`/api/settings/startup-profiles?windowDays=${windowDays}`,
			),
	});
	const rows = profiles.data?.rows ?? [];

	// ---- #160 PR4: probe designation + batch runner + probe list ----
	const queryClient = useQueryClient();
	const designation = useQuery({
		queryKey: ["startup-probe-designation"],
		queryFn: () =>
			apiFetch<{ designation: ProbeDesignation | null }>(
				"/api/settings/startup-probes",
			),
	});
	const credentials = useQuery({
		queryKey: ["credentials"],
		queryFn: () => apiFetch<CredentialSummaryWire[]>("/api/credentials"),
	});
	const accounts = useQuery({
		queryKey: ["bitmovin-accounts"],
		queryFn: () =>
			apiFetch<Array<{ id: string; label: string }>>("/api/bitmovin-accounts"),
	});
	const probeChannels = useQuery({
		queryKey: ["probe-channels"],
		refetchInterval: 15_000,
		queryFn: () =>
			apiFetch<{ items: ProbeChannelItem[] }>(
				"/api/live-channels?probes=only&limit=50",
			),
	});
	const [desCredential, setDesCredential] = useState("");
	const [desAccount, setDesAccount] = useState("");
	const [desBucket, setDesBucket] = useState("");
	const [desPrefix, setDesPrefix] = useState("probes/startup/");
	const [desDeadline, setDesDeadline] = useState("8");
	// review-287 M1: seed the form from the saved designation so the operator
	// EDITS the current values rather than facing blank selects that read
	// "Pick…" over an existing destination. Keyed on the designation id-ish
	// fields; only seeds once per load (the form is authoritative after).
	const seededRef = useRef(false);
	const loadedDes = designation.data?.designation ?? null;
	useEffect(() => {
		if (loadedDes && !seededRef.current) {
			seededRef.current = true;
			setDesCredential(loadedDes.credentialId);
			setDesAccount(loadedDes.bitmovinAccountId ?? "");
			setDesBucket(loadedDes.bucket);
			setDesPrefix(loadedDes.prefix);
			setDesDeadline(String(loadedDes.abandonDeadlineMinutes));
		}
	}, [loadedDes]);
	const saveDesignation = useMutation({
		mutationFn: () =>
			apiFetch<{ designation: ProbeDesignation }>(
				"/api/settings/startup-probes",
				{
					method: "PUT",
					body: JSON.stringify({
						credentialId: desCredential,
						bitmovinAccountId: desAccount,
						bucket: desBucket,
						prefix: desPrefix,
						abandonDeadlineMinutes: Number(desDeadline) || 8,
					}),
				},
			),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: ["startup-probe-designation"],
			}),
	});
	const [runRegion, setRunRegion] = useState("AWS_AP_NORTHEAST_1");
	const [runCount, setRunCount] = useState("3");
	const [ackWorstCase, setAckWorstCase] = useState(false);
	const runProbes = useMutation({
		mutationFn: () =>
			apiFetch<{ requestId: string }>("/api/settings/startup-probes/run", {
				method: "POST",
				body: JSON.stringify({
					regions: [runRegion],
					perRegion: Number(runCount) || 1,
					acknowledgeWorstCase: true,
				}),
			}),
		onSuccess: () => {
			setAckWorstCase(false);
			queryClient.invalidateQueries({ queryKey: ["probe-channels"] });
		},
	});
	const des = designation.data?.designation ?? null;
	// review-pr34 M5: the quote the operator acknowledges must be the bound
	// the RUNNER enforces — abandon deadline PLUS the stop-wait tail, per
	// probe, across every probe in the batch (the form launches one region).
	// review-288 N1: a STRANDED probe (encoder up, DB never records RUNNING)
	// bills until the encoder-side fuse fires, not the abandon deadline — so the
	// per-probe bound is the MAX of the two, else the quote under-states exactly
	// the case the fuse exists for (the fuse moved 1→30, above the 13-min
	// default deadline+tail).
	const worstCasePerProbeMinutes = Math.max(
		(des?.abandonDeadlineMinutes ?? 8) + PROBE_STOP_WAIT_MINUTES,
		PROBE_FUSE_MINUTES,
	);
	const worstCaseMinutes = (Number(runCount) || 1) * worstCasePerProbeMinutes;

	return (
		<div>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<div className="flex items-center gap-2">
						<h2 className="font-medium text-sm text-zinc-200">
							{t("startup.title")}
						</h2>
						<HelpOverlay labelFor={t("startup.title")}>
							{t("startup.explainer")}
						</HelpOverlay>
					</div>
				</div>
				<Field label={t("startup.window")} htmlFor={windowId}>
					<SelectNative
						id={windowId}
						value={String(windowDays)}
						onChange={(e) => setWindowDays(Number(e.target.value))}
					>
						{WINDOWS.map((days) => (
							<option key={days} value={days}>
								{t("startup.windowDays", { days })}
							</option>
						))}
					</SelectNative>
				</Field>
			</div>
			{profiles.isLoading ? (
				<p className="mt-3 text-xs text-zinc-500">{t("common.loading")}</p>
			) : profiles.isError ? (
				<p role="alert" className="mt-3 text-red-400 text-xs">
					{t("startup.loadFailed")}
				</p>
			) : rows.length === 0 ? (
				<p className="mt-3 text-xs text-zinc-500">{t("startup.empty")}</p>
			) : (
				<div className="mt-3 overflow-x-auto">
					<table className="w-full text-left text-sm">
						<thead>
							<tr className="border-zinc-800 border-b text-xs text-zinc-500">
								<th className="py-2 pr-4 font-normal">{t("startup.region")}</th>
								<th className="py-2 pr-4 font-normal">{t("startup.source")}</th>
								<th className="py-2 pr-4 font-normal">n</th>
								<th className="py-2 pr-4 font-normal">
									{t("startup.failures")}
								</th>
								<th className="py-2 pr-4 font-normal">
									{t("startup.censored")}
								</th>
								<th className="py-2 pr-4 font-normal">P50</th>
								<th className="py-2 pr-4 font-normal">P90</th>
								<th className="py-2 pr-4 font-normal">{t("startup.max")}</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((row) => (
								<tr
									key={`${row.region}-${row.source}`}
									className="border-zinc-900 border-b"
								>
									<td className="py-2 pr-4 font-mono text-xs text-zinc-200">
										{row.region}
									</td>
									<td className="py-2 pr-4 text-xs text-zinc-400">
										{row.source === "PROBE"
											? t("startup.sourceProbe")
											: t("startup.sourceChannel")}
									</td>
									<td className="py-2 pr-4 text-zinc-300">{row.profile.n}</td>
									<td className="py-2 pr-4 text-zinc-300">
										{row.profile.failures}
									</td>
									<td className="py-2 pr-4 text-zinc-300">
										{row.profile.censored}
									</td>
									<td className="py-2 pr-4 font-mono text-xs text-zinc-200">
										{seconds(row.profile.p50Seconds)}
									</td>
									<td className="py-2 pr-4 font-mono text-xs text-zinc-200">
										{seconds(row.profile.p90Seconds)}
									</td>
									<td className="py-2 pr-4 font-mono text-xs text-zinc-200">
										{seconds(row.profile.maxSeconds)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
					{rows.some(
						(row) => row.profile.n > 0 && row.profile.p50Seconds === null,
					) ? (
						<p className="mt-2 text-xs text-zinc-500">
							{t("startup.smallNNote")}
						</p>
					) : null}
				</div>
			)}

			{/* ---- Probe destination (design §4: designated, never defaulted) ---- */}
			<div className="mt-8 rounded-md border border-zinc-800 p-3">
				<h3 className="font-medium text-sm text-zinc-200">
					{t("startup.probeDestination")}
				</h3>
				<p className="mt-1 text-xs text-zinc-500">
					{t("startup.probeDestinationExplainer")}
				</p>
				{des ? (
					<p className="mt-2 font-mono text-xs text-zinc-300">
						{des.bucket}/{des.prefix}
						{/* review-287 B2: a LEGACY designation has no account —
						    des.bitmovinAccountId is undefined, and the i18n
						    interpolator THROWS on an undefined placeholder (by
						    design), which crashed the panel on the exact state
						    this fold exists to fix. Render the account line ONLY
						    when present; a legacy row gets the re-save note
						    below (m4: naming the account, not "designate a
						    destination" — one plainly exists). */}
						{des.bitmovinAccountId ? (
							<span className="ml-2 text-zinc-400">
								{t("startup.runsUnder", {
									account:
										(accounts.data ?? []).find(
											(a) => a.id === des.bitmovinAccountId,
										)?.label ?? des.bitmovinAccountId,
								})}
							</span>
						) : (
							<span className="ml-2 text-amber-400">
								{t("startup.reSaveForAccount")}
							</span>
						)}
						<span className="ml-2 text-zinc-500">
							{t("startup.abandonAfter", {
								minutes: des.abandonDeadlineMinutes,
							})}
						</span>
					</p>
				) : (
					<p className="mt-2 text-amber-400 text-xs">
						{t("startup.noDestinationYet")}
					</p>
				)}
				<RoleAccess control="settings.live.startup-probes">
					<div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
						<Field label={t("startup.credential")} htmlFor="sp-cred">
							<SelectNative
								id="sp-cred"
								value={desCredential}
								onChange={(e) => setDesCredential(e.target.value)}
							>
								<option value="">{t("startup.pickCredential")}</option>
								{(credentials.data ?? []).map((credential) => (
									<option key={credential.id} value={credential.id}>
										{credential.label}
									</option>
								))}
							</SelectNative>
						</Field>
						<Field label={t("startup.account")} htmlFor="sp-account">
							<SelectNative
								id="sp-account"
								value={desAccount}
								onChange={(e) => setDesAccount(e.target.value)}
							>
								<option value="">{t("startup.pickAccount")}</option>
								{(accounts.data ?? []).map((account) => (
									<option key={account.id} value={account.id}>
										{account.label}
									</option>
								))}
							</SelectNative>
						</Field>
						<Field label={t("startup.bucket")} htmlFor="sp-bucket">
							<Input
								id="sp-bucket"
								value={desBucket}
								onChange={(e) => setDesBucket(e.target.value)}
							/>
						</Field>
						<Field
							label={t("startup.prefix")}
							htmlFor="sp-prefix"
							help={t("startup.prefixHint")}
						>
							<Input
								id="sp-prefix"
								value={desPrefix}
								onChange={(e) => setDesPrefix(e.target.value)}
							/>
						</Field>
						<Field label={t("startup.abandonDeadline")} htmlFor="sp-deadline">
							<Input
								id="sp-deadline"
								type="number"
								min={1}
								max={15}
								value={desDeadline}
								onChange={(e) => setDesDeadline(e.target.value)}
							/>
						</Field>
					</div>
					<div className="mt-3 flex items-center gap-3">
						<Button
							type="button"
							variant="secondary"
							onClick={() => saveDesignation.mutate()}
							disabled={
								saveDesignation.isPending ||
								desCredential === "" ||
								desAccount === "" ||
								desBucket === ""
							}
						>
							{saveDesignation.isPending
								? t("startup.verifyingDelete")
								: t("startup.saveDestination")}
						</Button>
						{saveDesignation.isError ? (
							<p role="alert" className="text-red-400 text-xs">
								{saveDesignation.error instanceof Error
									? saveDesignation.error.message
									: t("startup.designationFailed")}
							</p>
						) : null}
						{saveDesignation.isSuccess ? (
							<p className="text-emerald-400 text-xs">
								{t("startup.deleteVerified")}
							</p>
						) : null}
					</div>
				</RoleAccess>
			</div>

			{/* ---- Probe runner (bills; worst-case confirm) ---- */}
			<RoleAccess control="settings.live.startup-probes">
				<div className="mt-4 rounded-md border border-zinc-800 p-3">
					<h3 className="font-medium text-sm text-zinc-200">
						{t("startup.runProbes")}
					</h3>
					<p className="mt-1 text-xs text-zinc-500">
						{t("startup.runProbesExplainer")}
					</p>
					<div className="mt-3 grid gap-3 sm:grid-cols-3">
						<Field label={t("startup.region")} htmlFor="sp-region">
							<SelectNative
								id="sp-region"
								value={runRegion}
								onChange={(e) => setRunRegion(e.target.value)}
							>
								{[
									"AWS_AP_NORTHEAST_1",
									"AWS_EU_WEST_1",
									"AWS_US_EAST_1",
									...AGGREGATE_CLOUD_REGIONS,
								].map((region) => (
									<option key={region} value={region}>
										{region}
									</option>
								))}
							</SelectNative>
						</Field>
						<Field label={t("startup.probeCount")} htmlFor="sp-count">
							<Input
								id="sp-count"
								type="number"
								min={1}
								max={10}
								value={runCount}
								onChange={(e) => setRunCount(e.target.value)}
							/>
						</Field>
					</div>
					<p className="mt-2 text-amber-400 text-xs">
						{t("startup.worstCaseLine", {
							count: Number(runCount) || 1,
							perProbe: worstCasePerProbeMinutes,
							minutes: worstCaseMinutes,
						})}
					</p>
					<label className="mt-2 flex items-center gap-2 text-xs text-zinc-300">
						<input
							type="checkbox"
							checked={ackWorstCase}
							onChange={(e) => setAckWorstCase(e.target.checked)}
						/>
						{t("startup.acknowledgeWorstCase")}
					</label>
					<div className="mt-3 flex items-center gap-3">
						<Button
							type="button"
							onClick={() => runProbes.mutate()}
							disabled={
								runProbes.isPending || !ackWorstCase || !des?.bitmovinAccountId
							}
						>
							{t("startup.launchProbes")}
						</Button>
						{/* m4: the OLD guard was !des?.bitmovinAccountId, true for BOTH
					    no-designation AND a legacy row (has a destination, no
					    account) — so it told a legacy row "designate a destination
					    first" while the summary above showed its bucket/prefix, a
					    contradiction. Show this hint ONLY when there is genuinely no
					    destination; a legacy row's real gap (re-save for the account)
					    is already named by the amber note in the summary, so
					    repeating it here would just duplicate that sentence. */}
						{!des ? (
							<p className="text-xs text-zinc-500">
								{t("startup.destinationFirst")}
							</p>
						) : null}
						{runProbes.isError ? (
							<p role="alert" className="text-red-400 text-xs">
								{runProbes.error instanceof Error
									? runProbes.error.message
									: t("startup.launchFailed")}
							</p>
						) : null}
						{runProbes.isSuccess ? (
							<p className="text-emerald-400 text-xs">
								{t("startup.probesEnqueued")}
							</p>
						) : null}
					</div>
				</div>
			</RoleAccess>

			{/* ---- Probe list (stranding shows loudly — reset-unblocking duty) ---- */}
			<div className="mt-4">
				<h3 className="font-medium text-sm text-zinc-200">
					{t("startup.probeList")}
				</h3>
				{(probeChannels.data?.items ?? []).length === 0 ? (
					<p className="mt-1 text-xs text-zinc-500">
						{t("startup.noProbesYet")}
					</p>
				) : (
					<ul className="mt-2 space-y-1">
						{(probeChannels.data?.items ?? []).map((probe) => (
							<li
								key={probe.id}
								className="flex flex-wrap items-center gap-3 rounded-md border border-zinc-800 px-3 py-2 text-xs"
							>
								<span className="font-mono text-zinc-300">{probe.name}</span>
								<Badge
									tone={
										probe.status === "STOPPED"
											? "neutral"
											: probe.status === "ERROR"
												? "error"
												: "ok"
									}
								>
									{probe.status}
								</Badge>
								{probe.status === "STOPPED" && probe.error ? (
									<span className="text-amber-400">
										{t("startup.strandedProbe")}
									</span>
								) : null}
								<span className="grow" />
								<Link className="underline" href={`/live/${probe.id}`}>
									{t("startup.openProbe")}
								</Link>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}

type ProbeDesignation = {
	credentialId: string;
	bitmovinAccountId?: string;
	bucket: string;
	prefix: string;
	abandonDeadlineMinutes: number;
};

type ProbeChannelItem = {
	id: string;
	name: string;
	status: string;
	error: string | null;
};
