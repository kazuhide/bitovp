"use client";

import {
	liveChannelPlanSchema,
	rebaseDestinations,
	renderTemplateOutputPrefix,
} from "@bitovp/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ApiError, apiFetch } from "@/lib/api";
import { useCreationSubmission } from "@/lib/creation-submission-hook";
import { localizedCustomerError } from "@/lib/customer-error";
import type { MessageKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/context";
import {
	EMPTY_SCHEDULE_DRAFT,
	type ScheduleDraft,
	ScheduleSection,
	scheduleFromDraft,
} from "../live/new/schedule-section";

type PresetDetail = {
	id: string;
	name: string;
	body: unknown;
	revision: number;
};

const DEFAULT_NAME_TEMPLATE = "{template} {date}";
const DEFAULT_PREFIX_TEMPLATE = "{template}/{date}-{uuid}";

/**
 * The LIVE launch form : a live plan needs no source
 * substitution (ingest is push), so the launcher asks only name + broadcast
 * slot (the SAME ScheduleSection as /live/new — absolute times, owner
 * decision §9.1-3). Everything else is the template's; the channel plan is
 * the template body renamed, re-parsed server-side like every create.
 */
export function LiveLaunchDialog({
	presetId,
	onClose,
}: {
	presetId: string | null;
	onClose: () => void;
}) {
	const { t } = useT();
	const router = useRouter();
	const [name, setName] = useState("");
	const [prefixTemplate, setPrefixTemplate] = useState(DEFAULT_PREFIX_TEMPLATE);
	const [prefixError, setPrefixError] = useState<string | null>(null);
	const [scheduleDraft, setScheduleDraft] =
		useState<ScheduleDraft>(EMPTY_SCHEDULE_DRAFT);
	const [seededFor, setSeededFor] = useState<string | null>(null);

	const detail = useQuery({
		queryKey: ["template-live-launch", presetId],
		enabled: presetId !== null,
		queryFn: () => apiFetch<PresetDetail>(`/api/presets/${presetId}`),
	});
	const creation = useCreationSubmission(
		"live",
		`template:${presetId}:${detail.data?.revision ?? "loading"}`,
		presetId !== null && detail.data?.id === presetId,
	);

	const plan = useMemo(() => {
		if (!detail.data) {
			return null;
		}
		const parsed = liveChannelPlanSchema.safeParse(detail.data.body);
		return parsed.success ? parsed.data : null;
	}, [detail.data]);

	useEffect(() => {
		if (
			!detail.data ||
			!creation.seed ||
			`${detail.data.id}:${creation.seed.nonce}` === seededFor
		) {
			return;
		}
		setSeededFor(`${detail.data.id}:${creation.seed.nonce}`);
		setScheduleDraft(EMPTY_SCHEDULE_DRAFT);
		setPrefixTemplate(DEFAULT_PREFIX_TEMPLATE);
		setPrefixError(null);
		setName(
			renderTemplateOutputPrefix(DEFAULT_NAME_TEMPLATE, {
				objectKey: "",
				templateName: detail.data.name,
				now: new Date(creation.seed.createdAt),
				uuid: creation.seed.nonce,
			}),
		);
	}, [detail.data, seededFor, creation.seed]);

	const preview = useMemo(
		() =>
			renderTemplateOutputPrefix(prefixTemplate, {
				objectKey: "",
				templateName: detail.data?.name ?? "",
				now: new Date(creation.seed?.createdAt ?? Date.now()),
				uuid: "xxxxxxxx",
			}),
		[prefixTemplate, detail.data?.name, creation.seed],
	);
	const launch = useMutation({
		mutationFn: () => {
			if (!detail.data || !plan || !creation.seed) {
				throw new Error("not loaded");
			}
			const verdict = scheduleFromDraft(scheduleDraft);
			if (!verdict.ok) {
				throw new ApiError(400, t(verdict.errorKey as MessageKey));
			}
			// review-109pr1 L1 (Critical): §4.2 promised two channels from one
			// template never share output paths — the first cut posted the
			// template's own destinations verbatim, so launching twice wrote
			// the same origin paths (corrupted timeline / silent overwrite).
			// Same shared rebase as VOD and watch (#87's rule): every
			// destination under a per-launch prefix, empty prefix refused.
			const prefix = renderTemplateOutputPrefix(prefixTemplate, {
				objectKey: "",
				templateName: detail.data.name,
				now: new Date(creation.seed.createdAt),
				uuid: "xxxxxxxx",
			});
			if (prefix === "") {
				setPrefixError(t("templates.livePrefixEmpty"));
				return Promise.resolve(null);
			}
			setPrefixError(null);
			const intent = {
				plan,
				name,
				prefixTemplate,
				templateName: detail.data.name,
				schedule: verdict.schedule,
				presetId: detail.data.id,
				presetRevision: detail.data.revision,
				renderedAt: creation.seed.createdAt,
			};
			return creation.submit<{ id: string }>(intent, (seed, snapshot) => {
				const frozen = snapshot as typeof intent;
				const stablePrefix = renderTemplateOutputPrefix(frozen.prefixTemplate, {
					objectKey: "",
					templateName: frozen.templateName,
					now: new Date(frozen.renderedAt),
					uuid: seed.nonce,
				});
				const rebased = liveChannelPlanSchema.parse(
					rebaseDestinations(frozen.plan, stablePrefix),
				);
				return {
					plan: { ...rebased, name: frozen.name },
					...(frozen.schedule ? { schedule: frozen.schedule } : {}),
					presetId: frozen.presetId,
					presetRevision: frozen.presetRevision,
				};
			});
		},
		onSuccess: (channel) => {
			if (channel) {
				onClose();
				router.push(`/live/${channel.id}`);
			}
		},
	});

	const launchFailure = launch.error ?? creation.seedError;
	const launchFailureKey =
		(
			[
				"creationSubmission.sessionUnavailable",
				"creationSubmission.storageUnavailable",
				"creationSubmission.pendingLimit",
				"creationSubmission.responseUnavailable",
			] as const
		).find(
			(key) =>
				launchFailure instanceof ApiError && launchFailure.message === t(key),
		) ?? "ui.createFailed";
	return (
		<Dialog
			open={presetId !== null}
			onOpenChange={(open) => {
				if (!open) {
					setSeededFor(null);
					onClose();
				}
			}}
			title={t("templates.launchLiveTitle", {
				name: detail.data?.name ?? "…",
			})}
			wide
		>
			{detail.isPending ? (
				<p className="text-xs text-zinc-500">{t("templates.loading")}</p>
			) : !plan ? (
				<p className="text-rose-400 text-sm">{t("templates.notALivePlan")}</p>
			) : (
				<div className="space-y-4">
					<Field htmlFor="tpl-live-name" label={t("templates.channelName")}>
						<Input
							id="tpl-live-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
						/>
					</Field>

					<Field
						htmlFor="tpl-live-prefix"
						label={t("templates.outputPrefix")}
						hint={t("templates.outputPrefixPreview", { preview })}
						{...(prefixError ? { error: prefixError } : {})}
					>
						<Input
							id="tpl-live-prefix"
							value={prefixTemplate}
							onChange={(e) => setPrefixTemplate(e.target.value)}
						/>
					</Field>

					<ScheduleSection
						draft={scheduleDraft}
						onPatch={(partial) =>
							setScheduleDraft((prev) => ({ ...prev, ...partial }))
						}
					/>

					{launch.isError || creation.seedError ? (
						<p className="text-rose-400 text-xs">
							{localizedCustomerError(t, launchFailure, launchFailureKey)}
						</p>
					) : null}

					<div className="flex justify-end pt-2">
						<Button
							disabled={
								launch.isPending || name.trim() === "" || !creation.seed
							}
							onClick={() => launch.mutate()}
						>
							{launch.isPending
								? t("templates.creating")
								: t("templates.createChannel")}
						</Button>
					</div>
				</div>
			)}
		</Dialog>
	);
}
