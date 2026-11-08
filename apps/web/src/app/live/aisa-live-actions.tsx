"use client";

import { useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { AisaActionBody, AisaAnalysis } from "@/lib/aisa-live/contracts";
import { apiFetch } from "@/lib/api";
import { RoleAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";

export function AisaLiveActions({
	accountId,
	analysis,
	disabled,
	onRefresh,
}: {
	accountId: string;
	analysis: AisaAnalysis;
	disabled: boolean;
	onRefresh: () => Promise<boolean>;
}) {
	const { t } = useT();
	const [esVersion, setEsVersion] = useState("");
	const [aicaVersion, setAicaVersion] = useState("");
	const [attempted, setAttempted] = useState<"start" | "stop" | null>(null);
	const blocked =
		attempted === "start"
			? analysis.status === "CREATED"
			: attempted === "stop" &&
				(analysis.status === "QUEUED" || analysis.status === "RUNNING");
	const sending = useRef(false);
	const action = useMutation({
		mutationFn: (body: AisaActionBody) =>
			apiFetch<AisaAnalysis>(
				`/api/live/analyses/${analysis.analysisId}/actions`,
				{ method: "POST", body: JSON.stringify(body) },
			),
		retry: false,
		onSettled: () => {
			sending.current = false;
			void onRefresh();
		},
	});
	const send = (name: "start" | "stop") => {
		if (sending.current || disabled || blocked) return;
		sending.current = true;
		setAttempted(name);
		action.mutate({
			bitmovinAccountId: accountId,
			action: name,
			...(name === "start" && esVersion.trim()
				? { esVersion: esVersion.trim() }
				: {}),
			...(name === "start" && aicaVersion.trim()
				? { aicaVersion: aicaVersion.trim() }
				: {}),
		});
	};
	return (
		<RoleAccess control="live.aisa.actions">
			<div className="space-y-4 rounded-md border border-zinc-800 p-4">
				{analysis.status === "CREATED" ? (
					<details>
						<summary className="cursor-pointer text-sm text-zinc-300">
							{t("aisaLive.versions")}
						</summary>
						<div className="mt-4 grid gap-4 sm:grid-cols-2">
							<Field
								label={t("aisaLive.esVersion")}
								htmlFor="aisa-es-version"
								hint={t("aisaLive.defaultHint")}
							>
								<Input
									id="aisa-es-version"
									value={esVersion}
									onChange={(event) => setEsVersion(event.target.value)}
									maxLength={128}
									disabled={action.isPending}
								/>
							</Field>
							<Field
								label={t("aisaLive.aicaVersion")}
								htmlFor="aisa-aica-version"
								hint={t("aisaLive.defaultHint")}
							>
								<Input
									id="aisa-aica-version"
									value={aicaVersion}
									onChange={(event) => setAicaVersion(event.target.value)}
									maxLength={128}
									disabled={action.isPending}
								/>
							</Field>
						</div>
					</details>
				) : null}
				<div className="flex flex-wrap gap-3">
					{analysis.status === "CREATED" ? (
						<Button
							disabled={disabled || action.isPending || blocked}
							onClick={() => send("start")}
						>
							{t(action.isPending ? "aisaLive.working" : "aisaLive.start")}
						</Button>
					) : null}
					{analysis.status === "QUEUED" || analysis.status === "RUNNING" ? (
						<Button
							variant="destructive"
							disabled={disabled || action.isPending || blocked}
							onClick={() => send("stop")}
						>
							{t(action.isPending ? "aisaLive.working" : "aisaLive.stop")}
						</Button>
					) : null}
				</div>
				{blocked && !action.isPending ? (
					<Button
						variant="secondary"
						disabled={disabled}
						onClick={async () => {
							if (await onRefresh()) setAttempted(null);
						}}
					>
						{t("aisaLive.checkState")}
					</Button>
				) : null}
				{action.isError ? (
					<p role="alert" className="text-sm text-red-300">
						{t("aisaLive.requestFailed")} {t("aisaLive.actionUncertain")}
					</p>
				) : null}
			</div>
		</RoleAccess>
	);
}
