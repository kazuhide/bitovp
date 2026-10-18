"use client";

import { BROWSABLE_CREDENTIAL_PROVIDERS } from "@bitovp/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useId, useState } from "react";
import {
	StoragePicker,
	type StoragePickerSelection,
} from "@/components/storage-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { Input } from "@/components/ui/input";
import { ApiError, apiFetch } from "@/lib/api";
import { RoleAccess } from "@/lib/auth/use-role-access";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/context";
import { zodIssueMessage } from "@/lib/i18n/zod-issue-message";
import { watchRuleCreateSchema } from "@/lib/watch/schemas";

/**
 * Watch folders : the hot-folder rules — list with state
 * counts, a create form (bucket/prefix through the SAME StoragePicker the
 * wizards use; FULL_PLAN preset picker), and a per-rule object table with
 * job links and re-arm. The page states the contract in its own copy: we
 * only ever LIST your bucket, never write to it.
 */

type RuleRow = {
	id: string;
	name: string;
	credentialId: string;
	credentialLabel: string;
	bucket: string;
	prefix: string;
	extensions: string[];
	presetId: string;
	presetName: string;
	outputPrefixTemplate: string;
	labels: string[];
	enabled: boolean;
	pollIntervalSec: number;
	stabilityChecks: number;
	maxConcurrentJobs: number;
	lastSweepAt: string | null;
	disarmedByResetAt: string | null;
	lastError: string | null;
	objectCounts: Record<string, number>;
};

type ObjectRow = {
	id: string;
	objectKey: string;
	state: "SEEN" | "STABLE" | "SUBMITTED" | "SKIPPED" | "ERROR";
	stableCount: number;
	error: string | null;
	updatedAt: string;
	encodingJob: { id: string; status: string; name: string } | null;
};

type PresetOption = { id: string; name: string };

const STATE_TONE: Record<ObjectRow["state"], "neutral" | "ok" | "error"> = {
	SEEN: "neutral",
	STABLE: "neutral",
	SUBMITTED: "ok",
	SKIPPED: "neutral",
	ERROR: "error",
};

const SELECT_CLASS =
	"h-9 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 text-sm text-zinc-200";

export function WatchFoldersClient() {
	const { t } = useT();
	const queryClient = useQueryClient();
	const nameId = useId();
	const presetId = useId();
	const extId = useId();
	const templateId = useId();

	const [pickerOpen, setPickerOpen] = useState(false);
	const [location, setLocation] = useState<StoragePickerSelection | null>(null);
	const [name, setName] = useState("");
	const [preset, setPreset] = useState("");
	const [extensionsCsv, setExtensionsCsv] = useState("mp4, mov, mxf");
	const [template, setTemplate] = useState(
		"watch/{rule}/{date}/{basename}-{uuid}",
	);
	const [issues, setIssues] = useState<string[]>([]);
	const [expanded, setExpanded] = useState<string | null>(null);

	const rulesKey = ["watch-rules"];
	const rules = useQuery({
		queryKey: rulesKey,
		refetchInterval: 30_000,
		queryFn: () => apiFetch<RuleRow[]>("/api/watch-rules"),
	});
	const presets = useQuery({
		queryKey: ["presets", "FULL_PLAN"],
		queryFn: () => apiFetch<PresetOption[]>("/api/presets"),
	});
	const detail = useQuery({
		queryKey: ["watch-rule", expanded],
		enabled: expanded !== null,
		refetchInterval: 15_000,
		queryFn: () =>
			apiFetch<RuleRow & { objects: ObjectRow[] }>(
				`/api/watch-rules/${expanded}`,
			),
	});

	const invalidate = () => {
		queryClient.invalidateQueries({ queryKey: rulesKey });
		if (expanded) {
			queryClient.invalidateQueries({ queryKey: ["watch-rule", expanded] });
		}
	};

	const create = useMutation({
		mutationFn: (payload: unknown) =>
			apiFetch("/api/watch-rules", {
				method: "POST",
				body: JSON.stringify(payload),
			}),
		onSuccess: () => {
			setName("");
			invalidate();
		},
	});
	const toggle = useMutation({
		mutationFn: ({
			id,
			enabled,
			acknowledgeRedetection,
		}: {
			id: string;
			enabled: boolean;
			acknowledgeRedetection?: true;
		}) =>
			apiFetch(`/api/watch-rules/${id}`, {
				method: "PATCH",
				body: JSON.stringify({
					enabled,
					...(acknowledgeRedetection ? { acknowledgeRedetection } : {}),
				}),
			}),
		onSuccess: invalidate,
	});
	/**
	 * : enabling a reset-disarmed rule re-detects EVERYTHING under
	 * the prefix (the reset deleted the at-most-once memory) and submits a
	 * billable encoding per object. The route refuses without the explicit
	 * acknowledgement; this dialog is where the operator gives it.
	 */
	const [confirmEnable, setConfirmEnable] = useState<RuleRow | null>(null);
	const remove = useMutation({
		mutationFn: (id: string) =>
			apiFetch(`/api/watch-rules/${id}`, { method: "DELETE" }),
		onSuccess: () => {
			setExpanded(null);
			invalidate();
		},
	});
	/** Two-step confirm (review-87b C-1): re-arm spends real money — the
	    first click arms the button, the second fires. The server 409s a
	    duplicate anyway; this stops the accidental one. */
	const [reArmConfirmId, setReArmConfirmId] = useState<string | null>(null);
	const reArm = useMutation({
		mutationFn: ({ ruleId, objectId }: { ruleId: string; objectId: string }) =>
			apiFetch(`/api/watch-rules/${ruleId}/re-arm`, {
				method: "POST",
				body: JSON.stringify({ objectId }),
			}),
		onSuccess: invalidate,
		// A refused re-arm (409 in-flight, 422 allowlist) must repaint the
		// TRUE state, not leave a silent dead button (#84's cancel lesson).
		onError: invalidate,
	});

	const submit = () => {
		setIssues([]);
		if (!location) {
			setIssues([t("watch.pickLocationFirst")]);
			return;
		}
		const parsed = watchRuleCreateSchema.safeParse({
			name,
			credentialId: location.credentialId,
			bucket: location.bucket,
			prefix: location.path,
			extensions: extensionsCsv
				.split(",")
				.map((item) => item.trim().toLowerCase())
				.filter((item) => item.length > 0),
			presetId: preset,
			outputPrefixTemplate: template,
		});
		if (!parsed.success) {
			setIssues(
				parsed.error.issues.map(
					(issue) =>
						`${issue.path.join(".") || "rule"}: ${zodIssueMessage(issue, t)}`,
				),
			);
			return;
		}
		create.mutate(parsed.data);
	};

	return (
		<section>
			<div className="flex items-center gap-2">
				<h1 className="font-semibold text-xl text-zinc-50">
					{t("watch.title")}
				</h1>
				<HelpOverlay labelFor={t("watch.title")}>
					{t("watch.explainer")}
				</HelpOverlay>
			</div>
			<p className="mt-1 text-xs text-emerald-400">
				{t("watch.noWritesPromise")}
			</p>

			{/* Create */}
			<RoleAccess control="settings.watch-folders">
				<div className="mt-4 rounded-md border border-zinc-800 p-3">
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
						<Field label={t("watch.name")} htmlFor={nameId}>
							<Input
								id={nameId}
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="mezzanine-drop"
							/>
						</Field>
						<Field label={t("watch.location")} htmlFor="watch-location">
							<div className="flex items-center gap-2">
								<Button
									id="watch-location"
									type="button"
									variant="secondary"
									onClick={() => setPickerOpen(true)}
								>
									{t("watch.pickLocation")}
								</Button>
								<span className="truncate font-mono text-xs text-zinc-400">
									{location
										? `${location.bucket}/${location.path}`
										: t("watch.noLocation")}
								</span>
							</div>
						</Field>
						<Field label={t("watch.preset")} htmlFor={presetId}>
							<select
								id={presetId}
								value={preset}
								onChange={(e) => setPreset(e.target.value)}
								className={SELECT_CLASS}
							>
								<option value="">
									{presets.isLoading
										? t("common.loading")
										: t("watch.presetPlaceholder")}
								</option>
								{(presets.data ?? []).map((option) => (
									<option key={option.id} value={option.id}>
										{option.name}
									</option>
								))}
							</select>
						</Field>
						<Field
							label={t("watch.extensions")}
							htmlFor={extId}
							help={t("watch.extensionsHint")}
						>
							<Input
								id={extId}
								value={extensionsCsv}
								onChange={(e) => setExtensionsCsv(e.target.value)}
							/>
						</Field>
						<Field
							label={t("watch.outputTemplate")}
							htmlFor={templateId}
							help={t("watch.outputTemplateHint")}
						>
							<Input
								id={templateId}
								value={template}
								onChange={(e) => setTemplate(e.target.value)}
								className="font-mono"
							/>
						</Field>
					</div>
					{issues.length > 0 ? (
						<ul role="alert" className="mt-2 space-y-1">
							{issues.map((issue) => (
								<li key={issue} className="text-red-400 text-xs">
									{issue}
								</li>
							))}
						</ul>
					) : null}
					{create.isError ? (
						<div role="alert" className="mt-2 text-red-400 text-xs">
							<p>
								{/* N-5: narrow on ApiError, not Error — every throw is an
							    Error, so the fallback was dead and raw transport noise
							    reached the screen. */}
								{create.error instanceof ApiError
									? create.error.message
									: t("watch.createFailed")}
							</p>
							{/* N-6: the 422's per-issue details were computed server-side
						    and thrown away here — the operator saw the verdict with
						    no reason. */}
							{create.error instanceof ApiError &&
							typeof create.error.details === "object" &&
							create.error.details !== null &&
							Array.isArray(
								(create.error.details as { issues?: unknown }).issues,
							)
								? (
										create.error.details as {
											issues: { code?: string; message?: string }[];
										}
									).issues.map((issue) => (
										<p key={`${issue.code}-${issue.message}`} className="pl-3">
											{issue.message}
										</p>
									))
								: null}
						</div>
					) : null}
					<div className="mt-3">
						<Button type="button" onClick={submit} disabled={create.isPending}>
							{t("watch.createButton")}
						</Button>
					</div>
				</div>
			</RoleAccess>

			{presets.isError && (
				<p role="alert" className="mt-4 text-red-400 text-sm">
					{t("common.requestFailed")}{" "}
					<Button
						variant="secondary"
						size="sm"
						disabled={presets.isFetching}
						onClick={() => presets.refetch()}
					>
						{t("settingsForms.retry")}
					</Button>
				</p>
			)}
			{(toggle.isError || remove.isError) && (
				<p role="alert" className="mt-4 text-red-400 text-sm">
					{t("common.requestFailed")}
				</p>
			)}
			{/* Rules */}
			{rules.isLoading ? (
				<p className="mt-4 text-xs text-zinc-500">{t("common.loading")}</p>
			) : rules.isError ? (
				<p role="alert" className="mt-4 text-red-400 text-sm">
					{t("common.requestFailed")}{" "}
					<Button
						variant="secondary"
						size="sm"
						disabled={rules.isFetching}
						onClick={() => rules.refetch()}
					>
						{t("settingsForms.retry")}
					</Button>
				</p>
			) : (rules.data ?? []).length === 0 ? (
				<p className="mt-4 text-sm text-zinc-500">{t("watch.noRules")}</p>
			) : (
				<ul className="mt-4 space-y-2">
					{(rules.data ?? []).map((rule) => (
						<li
							key={rule.id}
							className="rounded-md border border-zinc-800 px-3 py-2"
						>
							<div className="flex flex-wrap items-center gap-3">
								<span className="font-medium text-sm text-zinc-100">
									{rule.name}
								</span>
								<span
									title={`${rule.bucket}/${rule.prefix}`}
									className="min-w-0 truncate font-mono text-xs text-zinc-400"
								>
									{rule.bucket}/{rule.prefix}
								</span>
								<Badge tone={rule.enabled ? "ok" : "neutral"}>
									{rule.enabled ? t("watch.enabled") : t("watch.disabled")}
								</Badge>
								{rule.lastError ? (
									<Badge tone="error">{t("watch.errorBadge")}</Badge>
								) : null}
								<span className="text-xs text-zinc-500">
									{t("watch.countsLine", {
										submitted: rule.objectCounts.SUBMITTED ?? 0,
										pending:
											(rule.objectCounts.SEEN ?? 0) +
											(rule.objectCounts.STABLE ?? 0),
									})}
									{" · "}
									{t(
										(rule.objectCounts.ERROR ?? 0) === 1
											? "watch.countsErrorsOne"
											: "watch.countsErrorsOther",
										{ errors: rule.objectCounts.ERROR ?? 0 },
									)}
								</span>
								<span className="text-xs text-zinc-600">
									{rule.lastSweepAt
										? t("watch.lastSweep", {
												time: formatDateTime(rule.lastSweepAt),
											})
										: t("watch.neverSwept")}
								</span>
								<span className="grow" />
								<Button
									type="button"
									variant="secondary"
									onClick={() =>
										setExpanded(expanded === rule.id ? null : rule.id)
									}
								>
									{expanded === rule.id
										? t("watch.collapse")
										: t("watch.objects")}
								</Button>
								<RoleAccess control="settings.watch-folders">
									<Button
										type="button"
										variant="secondary"
										disabled={toggle.isPending || remove.isPending}
										onClick={() => {
											remove.reset();
											if (!rule.enabled && rule.disarmedByResetAt !== null) {
												setConfirmEnable(rule);
												return;
											}
											toggle.mutate({ id: rule.id, enabled: !rule.enabled });
										}}
									>
										{rule.enabled ? t("watch.disable") : t("watch.enable")}
									</Button>
									<Button
										type="button"
										variant="secondary"
										disabled={toggle.isPending || remove.isPending}
										onClick={() => {
											if (
												window.confirm(
													t("watch.deleteConfirm", { name: rule.name }),
												)
											) {
												toggle.reset();
												remove.mutate(rule.id);
											}
										}}
									>
										{t("watch.delete")}
									</Button>
								</RoleAccess>
							</div>
							{rule.lastError ? (
								<p className="mt-1 break-words text-red-400 text-xs">
									{rule.lastError}
								</p>
							) : null}
							{expanded === rule.id ? (
								<div className="mt-2 border-zinc-800 border-t pt-2">
									{detail.isLoading ? (
										<p className="text-xs text-zinc-500">
											{t("common.loading")}
										</p>
									) : detail.isError ? (
										<p role="alert" className="text-red-400 text-sm">
											{t("common.requestFailed")}{" "}
											<Button
												variant="secondary"
												size="sm"
												disabled={detail.isFetching}
												onClick={() => detail.refetch()}
											>
												{t("settingsForms.retry")}
											</Button>
										</p>
									) : (detail.data?.objects ?? []).length === 0 ? (
										<p className="text-xs text-zinc-500">
											{t("watch.noObjects")}
										</p>
									) : (
										<ul className="space-y-1">
											{(detail.data?.objects ?? []).map((object) => (
												<li
													key={object.id}
													className="flex flex-wrap items-center gap-3 py-1"
												>
													<Badge tone={STATE_TONE[object.state]}>
														{object.state}
													</Badge>
													<span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-300">
														{object.objectKey}
													</span>
													{object.encodingJob ? (
														<Link
															href={`/vod/jobs/${object.encodingJob.id}`}
															className="text-emerald-400 text-xs underline"
														>
															{t("watch.jobLink", {
																status: object.encodingJob.status,
															})}
														</Link>
													) : null}
													{object.error ? (
														<span className="break-words text-red-400 text-xs">
															{object.error}
														</span>
													) : null}
													{object.state === "SUBMITTED" ||
													object.state === "ERROR" ? (
														<RoleAccess control="settings.watch-folders">
															<Button
																type="button"
																variant="secondary"
																onClick={() => {
																	if (reArmConfirmId === object.id) {
																		setReArmConfirmId(null);
																		reArm.mutate({
																			ruleId: rule.id,
																			objectId: object.id,
																		});
																		return;
																	}
																	setReArmConfirmId(object.id);
																}}
																disabled={reArm.isPending}
															>
																{reArmConfirmId === object.id
																	? t("watch.reArmConfirm")
																	: t("watch.reArm")}
															</Button>
														</RoleAccess>
													) : null}
													{reArm.isError &&
													reArm.variables?.objectId === object.id ? (
														<span role="alert" className="text-red-400 text-xs">
															{t("watch.reArmFailed", {
																message:
																	reArm.error instanceof Error
																		? reArm.error.message
																		: String(reArm.error),
															})}
														</span>
													) : null}
												</li>
											))}
										</ul>
									)}
								</div>
							) : null}
						</li>
					))}
				</ul>
			)}

			<RoleAccess control="settings.watch-folders">
				<StoragePicker
					open={pickerOpen}
					mode="prefix"
					providers={[...BROWSABLE_CREDENTIAL_PROVIDERS]}
					onClose={() => setPickerOpen(false)}
					onSelect={(selection) => {
						setLocation(selection);
						setPickerOpen(false);
					}}
				/>
				<Dialog
					open={confirmEnable !== null}
					onOpenChange={(next) => {
						if (!next) {
							setConfirmEnable(null);
						}
					}}
					title={t("watch.redetectConfirmTitle")}
					description={t("watch.redetectConfirmBody", {
						name: confirmEnable?.name ?? "",
					})}
				>
					<div className="flex justify-end gap-2">
						<Button
							variant="secondary"
							size="sm"
							onClick={() => setConfirmEnable(null)}
						>
							{t("common.cancel")}
						</Button>
						<Button
							variant="destructive"
							size="sm"
							disabled={toggle.isPending}
							onClick={() => {
								if (confirmEnable) {
									toggle.mutate({
										id: confirmEnable.id,
										enabled: true,
										acknowledgeRedetection: true,
									});
								}
								setConfirmEnable(null);
							}}
						>
							{t("watch.redetectConfirmEnable")}
						</Button>
					</div>
				</Dialog>
			</RoleAccess>
		</section>
	);
}
