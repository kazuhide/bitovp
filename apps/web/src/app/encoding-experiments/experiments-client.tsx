"use client";

import {
	type ExperimentResult,
	type ExperimentRuntime,
	type ExperimentTrialInput,
	experimentRequestByteLimit,
	experimentScoringProfile,
	type experimentScoringProfiles,
	experimentVmafV1Profile,
} from "@bitovp/core/encoding-experiments";
import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, SelectNative, Textarea } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";
import { SdkSettings } from "./sdk-settings";

type Page<T> = { items: T[]; nextCursor: string | null };
type Source = { id: string; label: string };
type TrialStatus =
	| "PENDING"
	| "RUNNING"
	| "SUCCEEDED"
	| "FAILED"
	| "CANCELED"
	| "REJECTED";
type Campaign = {
	id: string;
	capabilityId: string;
	name: string;
	state: "RUNNING" | "PAUSED" | "CANCELED";
	sealed: boolean;
	statusCounts?: Partial<Record<TrialStatus, number>>;
	runtime?: Pick<ExperimentRuntime, "additionalScoringProfiles">;
};
type Trial = {
	id: string;
	status: TrialStatus;
	input: ExperimentTrialInput;
	result: ExperimentResult | null;
	failureCode?: string | null;
};
type ScoringProfile = (typeof experimentScoringProfiles)[number];
type Selection = {
	scoringProfileId: ScoringProfile;
	status: "selected" | "no_feasible_candidate" | "insufficient_evidence";
	trialId?: string;
	eligibleCount: number;
	incompleteCount: number;
};

type Capabilities = Pick<
	ExperimentRuntime,
	"additionalScoringProfiles" | "nvencSdk"
> & {
	available: boolean;
	capabilityId?: string;
	gpuName?: string;
	driverVersion?: string;
	supportedCodecs?: ExperimentTrialInput["codec"][];
	scoringProfileId?: string;
	reason?: string;
};

const apiPath = "/api/encoding-experiments/v1";
const statusOrder = [
	"PENDING",
	"RUNNING",
	"SUCCEEDED",
	"REJECTED",
	"FAILED",
	"CANCELED",
] as const;
const queryKey = ["encoding-experiments"];
const primaryVmafLabel = "VMAF v0.6.1";
const v1VmafLabel = "VMAF v1.0.16";

function editableTrial(json: string): Record<string, unknown> | undefined {
	try {
		const trial: unknown = JSON.parse(json);
		return trial !== null && typeof trial === "object" && !Array.isArray(trial)
			? (trial as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function VmafV1Cell({ result }: { result: ExperimentResult | null }) {
	const { t } = useT();
	const score = result?.additionalScores?.[0];
	return (
		<td className="px-2 py-2 tabular-nums">
			{score?.status === "failed" ? (
				<>
					{t("experiments.states.FAILED")}
					<div className="font-mono text-xs text-red-400">
						{score.failureCode}
					</div>
				</>
			) : (
				(score?.meanVmaf.toFixed(2) ?? "—")
			)}
		</td>
	);
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : null;
}

function rateMbps(result: ExperimentResult) {
	return (
		(8 * Number(result.videoBytes) * result.timeBase.den) /
		(Number(result.durationTicks) * result.timeBase.num * 1_000_000)
	);
}

function callPage<T>(path: string, cursor: string | null) {
	return apiFetch<Page<T>>(
		cursor ? `${path}?cursor=${encodeURIComponent(cursor)}` : path,
	);
}

export function ExperimentsClient() {
	const { t } = useT();
	const canManage = useMutationAccess("encoding-experiments.manage");
	const client = useQueryClient();
	const nameInput = useId();
	const campaignInput = useId();
	const sourceInput = useId();
	const trialInput = useId();
	const referenceInput = useId();
	const scoringProfileInput = useId();
	const rateInput = useId();
	const timeInput = useId();
	const [name, setName] = useState("");
	const [selected, setSelected] = useState<string>();
	const [sourceId, setSourceId] = useState("");
	const [trialJson, setTrialJson] = useState("");
	const [confirmCancel, setConfirmCancel] = useState<string>();
	const [referenceId, setReferenceId] = useState<string>();
	const [scoringProfile, setScoringProfile] = useState<ScoringProfile>(
		experimentScoringProfile,
	);
	const [bitrateCeiling, setBitrateCeiling] = useState("");
	const [timeCeiling, setTimeCeiling] = useState("");
	const retry = useRef<{ body: string; campaign: string; key: string }>(null);

	const capabilities = useQuery({
		queryKey: [...queryKey, "capabilities"],
		queryFn: () => apiFetch<Capabilities>(apiPath + "/capabilities"),
		refetchInterval: 15_000,
	});
	const sources = useQuery({
		queryKey: [...queryKey, "sources"],
		queryFn: () => apiFetch<Page<Source>>(apiPath + "/sources"),
		enabled: canManage && capabilities.data?.available === true,
	});
	const campaigns = useInfiniteQuery({
		queryKey: [...queryKey, "campaigns"],
		initialPageParam: null as string | null,
		queryFn: ({ pageParam }) =>
			callPage<Campaign>(apiPath + "/campaigns", pageParam),
		getNextPageParam: (page) => page.nextCursor ?? undefined,
	});
	const campaignItems =
		campaigns.data?.pages.flatMap((page) => page.items) ?? [];
	const campaignId = selected ?? campaignItems[0]?.id;
	const detail = useQuery({
		queryKey: [...queryKey, "campaign", campaignId],
		queryFn: () => apiFetch<Campaign>(`${apiPath}/campaigns/${campaignId}`),
		enabled: campaignId !== undefined,
		refetchInterval: (query) =>
			query.state.data?.state === "CANCELED" ? false : 3000,
	});
	const campaign = detail.data;
	const hasVmafV1 =
		campaign?.runtime?.additionalScoringProfiles?.[0]?.scoringProfileId ===
		experimentVmafV1Profile;
	const canQueueVmafV1 =
		hasVmafV1 &&
		campaign?.capabilityId === capabilities.data?.capabilityId &&
		capabilities.data?.additionalScoringProfiles?.[0]?.scoringProfileId ===
			experimentVmafV1Profile;
	const draft = editableTrial(trialJson);
	const nvencSdk = capabilities.data?.nvencSdk;
	const draftProfiles = draft?.additionalScoringProfiles;
	const measuresVmafV1 =
		Array.isArray(draftProfiles) &&
		draftProfiles.includes(experimentVmafV1Profile);
	const trials = useInfiniteQuery({
		queryKey: [...queryKey, "trials", campaignId],
		initialPageParam: null as string | null,
		queryFn: ({ pageParam }) =>
			callPage<Trial>(`${apiPath}/campaigns/${campaignId}/trials`, pageParam),
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		enabled: campaignId !== undefined,
		refetchInterval: (query) => {
			const open = campaign?.state !== "CANCELED" && !campaign?.sealed;
			const jobsActive =
				(campaign?.statusCounts?.PENDING ?? 0) +
					(campaign?.statusCounts?.RUNNING ?? 0) >
				0;
			const rowsStillActive = query.state.data?.pages.some((page) =>
				page.items.some(
					(trial) => trial.status === "PENDING" || trial.status === "RUNNING",
				),
			);
			return open || jobsActive || rowsStillActive ? 3000 : false;
		},
	});
	const trialItems = trials.data?.pages.flatMap((page) => page.items) ?? [];
	const measuredTrials = trialItems.filter(
		(trial) => trial.status === "SUCCEEDED",
	);
	const reference =
		measuredTrials.find((trial) => trial.id === referenceId) ??
		measuredTrials[0];
	const quality = useMutation({
		mutationFn: (trial: Trial) =>
			apiFetch<Selection>(
				`/api/encoding-experiments/v1/campaigns/${campaignId}/select`,
				{
					method: "POST",
					body: JSON.stringify({
						schemaVersion: 1,
						sourceId: trial.input.sourceId,
						window: trial.input.window,
						...(hasVmafV1 && scoringProfile === experimentVmafV1Profile
							? { scoringProfileId: experimentVmafV1Profile }
							: {}),
						constraints: {
							...(bitrateCeiling === ""
								? {}
								: { bitrateLimitBps: Number(bitrateCeiling) }),
							...(timeCeiling === ""
								? {}
								: { encodeTimeLimitMs: Number(timeCeiling) }),
						},
					}),
				},
			),
	});

	function chooseCampaign(id: string | undefined) {
		setSelected(id);
		setReferenceId(undefined);
		setScoringProfile(experimentScoringProfile);
		quality.reset();
	}

	function refresh() {
		return client.invalidateQueries({ queryKey });
	}

	const create = useMutation({
		mutationFn: () =>
			apiFetch<Campaign>("/api/encoding-experiments/v1/campaigns", {
				method: "POST",
				body: JSON.stringify({
					schemaVersion: 1,
					name,
					capabilityId: capabilities.data?.capabilityId,
				}),
			}),
		onSuccess: (created) => {
			chooseCampaign(created.id);
			setName("");
			return refresh();
		},
	});
	const enqueue = useMutation({
		mutationFn: () => {
			if (!draft) throw new Error(t("experiments.invalidJson"));
			if (!campaignId) throw new Error(t("experiments.selectCampaign"));
			const body = JSON.stringify({ schemaVersion: 1, trials: [draft] });
			if (
				retry.current?.body !== body ||
				retry.current.campaign !== campaignId
			) {
				const key = Array.from(
					crypto.getRandomValues(new Uint8Array(16)),
					(byte) => byte.toString(16).padStart(2, "0"),
				).join("");
				retry.current = { body, campaign: campaignId, key };
			}
			return apiFetch(
				`/api/encoding-experiments/v1/campaigns/${campaignId}/trials`,
				{
					method: "POST",
					body,
					headers: { "Idempotency-Key": retry.current.key },
				},
			);
		},
		onSuccess: refresh,
	});
	const updateState = useMutation({
		mutationFn: (action: "pause" | "resume" | "seal") =>
			apiFetch(`/api/encoding-experiments/v1/campaigns/${campaignId}`, {
				method: "PATCH",
				body: JSON.stringify({ action }),
			}),
		onSuccess: refresh,
	});
	const cancel = useMutation({
		mutationFn: () =>
			apiFetch(`/api/encoding-experiments/v1/campaigns/${campaignId}/cancel`, {
				method: "POST",
			}),
		onSuccess: () => {
			setConfirmCancel(undefined);
			return refresh();
		},
	});

	function toggleVmafV1(checked: boolean) {
		if (!draft) return;
		const next = { ...draft };
		if (checked) next.additionalScoringProfiles = [experimentVmafV1Profile];
		else delete next.additionalScoringProfiles;
		setTrialJson(JSON.stringify(next, null, 2));
	}

	function selectSource(id: string) {
		setSourceId(id);
		const codecs = capabilities.data?.supportedCodecs ?? [];
		const codec = codecs.includes("HEVC") ? "HEVC" : (codecs[0] ?? "HEVC");
		const trial: ExperimentTrialInput = {
			sourceId: id,
			window: {
				timeBase: { num: 1, den: 30 },
				startPts: "0",
				endPtsExclusive: "60",
			},
			codec,
			preset: "P5",
			tuning: "HIGH_QUALITY",
			config: {
				gopLength: 60,
				rcParams: { rateControlMode: "VBR", averageBitRate: 3500000 },
			},
		};
		setTrialJson(id ? JSON.stringify(trial, null, 2) : "");
	}

	const workerReady =
		capabilities.data?.available === true &&
		!!capabilities.data.capabilityId &&
		!capabilities.isError;
	const active = campaign && campaign.state !== "CANCELED";
	const busy =
		create.isPending ||
		enqueue.isPending ||
		updateState.isPending ||
		cancel.isPending ||
		quality.isPending;
	const failure = errorMessage(
		create.error ??
			enqueue.error ??
			updateState.error ??
			cancel.error ??
			quality.error ??
			capabilities.error ??
			campaigns.error ??
			detail.error ??
			trials.error ??
			sources.error,
	);
	return (
		<div className="mx-auto max-w-screen-xl space-y-6">
			<header className="flex flex-wrap items-start justify-between gap-3">
				<div className="space-y-1">
					<h1 className="font-semibold text-xl text-zinc-50">
						{t("experiments.title")}
					</h1>
					{workerReady ? (
						<p className="text-sm text-zinc-400">
							{[
								capabilities.data?.gpuName,
								capabilities.data?.driverVersion,
								capabilities.data?.scoringProfileId,
							]
								.filter(Boolean)
								.join(" · ")}
						</p>
					) : (
						<p role="status" className="text-sm text-zinc-400">
							{capabilities.isPending
								? t("common.loading")
								: t("experiments.workerUnavailable")}
							{capabilities.data?.reason
								? ` · ${capabilities.data.reason}`
								: null}
						</p>
					)}
				</div>
				{workerReady && <Badge tone="ok">NVENC</Badge>}
			</header>

			{failure && (
				<p role="alert" className="text-red-400 text-sm">
					{failure}
				</p>
			)}

			<div className="grid items-start gap-4 lg:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
				<section className="min-w-0 space-y-4 rounded-md border border-zinc-800 bg-zinc-950 p-4">
					<Field label={t("experiments.campaigns")} htmlFor={campaignInput}>
						<SelectNative
							id={campaignInput}
							value={campaignId ?? ""}
							onChange={(event) =>
								chooseCampaign(event.target.value || undefined)
							}
							disabled={busy}
						>
							<option value="" disabled>
								{t("experiments.selectCampaign")}
							</option>
							{selected &&
								campaign &&
								!campaignItems.some((item) => item.id === selected) && (
									<option value={selected}>{campaign.name}</option>
								)}
							{campaignItems.map((item) => (
								<option key={item.id} value={item.id}>
									{item.name}
								</option>
							))}
						</SelectNative>
					</Field>
					{campaigns.hasNextPage && (
						<Button
							variant="secondary"
							size="sm"
							disabled={campaigns.isFetchingNextPage}
							onClick={() => campaigns.fetchNextPage()}
						>
							{t("experiments.moreCampaigns")}
						</Button>
					)}
					{canManage && workerReady && (
						<div className="space-y-2">
							<Field label={t("experiments.campaignName")} htmlFor={nameInput}>
								<Input
									id={nameInput}
									value={name}
									onChange={(event) => setName(event.target.value)}
									maxLength={120}
								/>
							</Field>
							<Button
								onClick={() => create.mutate()}
								disabled={busy || !name.trim()}
							>
								{t("experiments.createCampaign")}
							</Button>
						</div>
					)}
					{canManage && workerReady && active && !campaign.sealed && (
						<div className="space-y-2 border-zinc-800 border-t pt-4">
							<Field label={t("experiments.source")} htmlFor={sourceInput}>
								<SelectNative
									id={sourceInput}
									value={sourceId}
									onChange={(event) => selectSource(event.target.value)}
								>
									<option value="">{t("experiments.selectSource")}</option>
									{sources.data?.items.map((source) => (
										<option key={source.id} value={source.id}>
											{source.label}
										</option>
									))}
								</SelectNative>
							</Field>
							{(canQueueVmafV1 || measuresVmafV1) && (
								<label className="flex items-center gap-2 text-sm">
									<input
										type="checkbox"
										checked={measuresVmafV1}
										disabled={busy || !draft}
										onChange={(event) => toggleVmafV1(event.target.checked)}
									/>
									{t("experiments.alsoMeasureVmafV1")}
								</label>
							)}
							{nvencSdk &&
								draft &&
								campaign.capabilityId === capabilities.data?.capabilityId && (
									<SdkSettings
										draft={draft}
										catalogSha256={nvencSdk.catalogSha256}
										disabled={busy}
										onChange={(next) =>
											setTrialJson(JSON.stringify(next, null, 2))
										}
									/>
								)}
							<Field label={t("experiments.trialJson")} htmlFor={trialInput}>
								<Textarea
									id={trialInput}
									value={trialJson}
									onChange={(event) => setTrialJson(event.target.value)}
									maxLength={experimentRequestByteLimit}
									rows={9}
								/>
							</Field>
							<Button
								onClick={() => enqueue.mutate()}
								disabled={busy || !trialJson.trim()}
							>
								{t("experiments.queueTrial")}
							</Button>
						</div>
					)}
				</section>

				<section className="min-w-0 space-y-4 rounded-md border border-zinc-800 bg-zinc-950 p-4">
					{campaign ? (
						<>
							<header className="flex flex-wrap items-center justify-between gap-3">
								<div className="flex min-w-0 flex-wrap items-center gap-2">
									<h2 className="wrap-anywhere font-medium">{campaign.name}</h2>
									<Badge>{t(`experiments.states.${campaign.state}`)}</Badge>
									{campaign.sealed && <Badge>{t("experiments.sealed")}</Badge>}
								</div>
								{canManage && active && (
									<div className="flex flex-wrap gap-2">
										<Button
											variant="secondary"
											size="sm"
											disabled={busy}
											onClick={() =>
												updateState.mutate(
													campaign.state === "PAUSED" ? "resume" : "pause",
												)
											}
										>
											{campaign.state === "PAUSED"
												? t("experiments.resume")
												: t("experiments.pause")}
										</Button>
										{!campaign.sealed && (
											<Button
												variant="secondary"
												size="sm"
												disabled={busy}
												onClick={() => updateState.mutate("seal")}
											>
												{t("experiments.seal")}
											</Button>
										)}
										{confirmCancel === campaign.id ? (
											<Button
												variant="secondary"
												size="sm"
												disabled={busy}
												onClick={() => cancel.mutate()}
											>
												{t("experiments.confirmCancel")}
											</Button>
										) : (
											<Button
												variant="secondary"
												size="sm"
												disabled={busy}
												onClick={() => setConfirmCancel(campaign.id)}
											>
												{t("experiments.cancel")}
											</Button>
										)}
									</div>
								)}
							</header>
							<dl className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
								{statusOrder.map((status) => (
									<div key={status}>
										<dt className="text-xs text-zinc-400">
											{t(`experiments.states.${status}`)}
										</dt>
										<dd className="tabular-nums text-zinc-100">
											{campaign.statusCounts?.[status] ?? 0}
										</dd>
									</div>
								))}
							</dl>
							{canManage && reference && (
								<div className="space-y-2 border-zinc-800 border-t pt-3">
									<Field
										label={t("experiments.reference")}
										htmlFor={referenceInput}
									>
										<SelectNative
											id={referenceInput}
											value={reference.id}
											disabled={busy}
											onChange={(event) => {
												setReferenceId(event.target.value);
												quality.reset();
											}}
										>
											{measuredTrials.map((trial) => {
												const { sourceId, window } = trial.input;
												return (
													<option key={trial.id} value={trial.id}>
														{`${sourceId} · ${window.startPts}–${window.endPtsExclusive} · ${window.timeBase.num}/${window.timeBase.den}`}
													</option>
												);
											})}
										</SelectNative>
									</Field>
									{hasVmafV1 && (
										<Field
											label={t("experiments.scoringProfile")}
											htmlFor={scoringProfileInput}
										>
											<SelectNative
												id={scoringProfileInput}
												value={scoringProfile}
												disabled={busy}
												onChange={(event) => {
													setScoringProfile(
														event.target.value === experimentVmafV1Profile
															? experimentVmafV1Profile
															: experimentScoringProfile,
													);
													quality.reset();
												}}
											>
												<option value={experimentScoringProfile}>
													{primaryVmafLabel}
												</option>
												<option value={experimentVmafV1Profile}>
													{v1VmafLabel}
												</option>
											</SelectNative>
										</Field>
									)}
									<div className="grid gap-2 sm:grid-cols-2">
										<Field
											label={t("experiments.bitrateCeiling")}
											htmlFor={rateInput}
										>
											<Input
												id={rateInput}
												type="number"
												min={1}
												step={1}
												value={bitrateCeiling}
												onChange={(event) => {
													setBitrateCeiling(event.target.value);
													quality.reset();
												}}
												disabled={busy}
											/>
										</Field>
										<Field
											label={t("experiments.timeCeiling")}
											htmlFor={timeInput}
										>
											<Input
												id={timeInput}
												type="number"
												min={1}
												step={1}
												value={timeCeiling}
												onChange={(event) => {
													setTimeCeiling(event.target.value);
													quality.reset();
												}}
												disabled={busy}
											/>
										</Field>
									</div>
									<Button
										size="sm"
										variant="secondary"
										onClick={() => quality.mutate(reference)}
										disabled={busy}
									>
										{t("experiments.selectBest")}
									</Button>
									{quality.data && (
										<p
											role="status"
											className="wrap-anywhere text-sm text-zinc-200"
										>
											{hasVmafV1 && (
												<span className="mr-2 text-zinc-400">
													{quality.data.scoringProfileId ===
													experimentVmafV1Profile
														? v1VmafLabel
														: primaryVmafLabel}
												</span>
											)}
											<span>
												{quality.data.status === "selected"
													? t("experiments.selectedTrial", {
															id: quality.data.trialId ?? "—",
														})
													: t(
															`experiments.selectionStatus.${quality.data.status}`,
														)}
											</span>
										</p>
									)}
								</div>
							)}
							<div className="overflow-x-auto">
								<table className="w-full whitespace-nowrap text-left text-sm">
									<thead className="border-zinc-800 border-b text-xs text-zinc-400">
										<tr>
											<th scope="col" className="px-2 py-2">
												{t("experiments.source")}
											</th>
											<th scope="col" className="px-2 py-2">
												{t("experiments.codec")}
											</th>
											<th scope="col" className="px-2 py-2">
												{t("experiments.status")}
											</th>
											<th scope="col" className="px-2 py-2">
												{primaryVmafLabel}
											</th>
											{hasVmafV1 && (
												<th scope="col" className="px-2 py-2">
													{v1VmafLabel}
												</th>
											)}
											<th scope="col" className="px-2 py-2">
												{t("experiments.measuredRate")}
											</th>
											<th scope="col" className="px-2 py-2">
												{t("experiments.encodeTime")}
											</th>
										</tr>
									</thead>
									<tbody>
										{trialItems.map((trial) => (
											<tr key={trial.id} className="border-zinc-900 border-b">
												<td className="px-2 py-2">{trial.input.sourceId}</td>
												<td className="px-2 py-2">{trial.input.codec}</td>
												<td className="px-2 py-2">
													{t(`experiments.states.${trial.status}`)}
													{trial.failureCode && (
														<div className="font-mono text-xs text-red-400">
															{trial.failureCode}
														</div>
													)}
												</td>
												<td className="px-2 py-2 tabular-nums">
													{trial.result?.meanVmaf.toFixed(2) ?? "—"}
												</td>
												{hasVmafV1 && <VmafV1Cell result={trial.result} />}
												<td className="px-2 py-2 tabular-nums">
													{trial.result
														? `${rateMbps(trial.result).toFixed(2)} Mb/s`
														: "—"}
												</td>
												<td className="px-2 py-2 tabular-nums">
													{trial.result?.encodeMs ?? "—"}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
							{trials.isSuccess && trialItems.length === 0 && (
								<p className="text-sm text-zinc-400">
									{t("experiments.emptyTrials")}
								</p>
							)}
							{trials.hasNextPage && (
								<Button
									variant="secondary"
									size="sm"
									disabled={trials.isFetchingNextPage}
									onClick={() => trials.fetchNextPage()}
								>
									{t("experiments.moreTrials")}
								</Button>
							)}
						</>
					) : (
						<p role="status" className="text-sm text-zinc-400">
							{campaigns.isPending || detail.isFetching
								? t("common.loading")
								: t("experiments.emptyCampaigns")}
						</p>
					)}
				</section>
			</div>
		</div>
	);
}
