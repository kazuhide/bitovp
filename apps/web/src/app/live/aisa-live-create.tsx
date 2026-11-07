"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	type AisaAnalysis,
	type AisaCreateBody,
	aisaCreateBodySchema,
} from "@/lib/aisa-live/contracts";
import { apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";
import { type AisaInputType, AisaLiveFields } from "./aisa-live-fields";
import {
	AisaAccountSelect,
	AisaPreviewLinks,
	AisaPreviewNotice,
	aisaDetailHref,
	useAisaAccounts,
} from "./aisa-live-shared";

export function AisaLiveCreate() {
	const { t } = useT();
	const router = useRouter();
	const accounts = useAisaAccounts();
	const canCreate = useMutationAccess("live.aisa.create");
	const [inputType, setInputType] = useState<AisaInputType>("RTMP");
	const [prefix, setPrefix] = useState("");
	const [invalid, setInvalid] = useState(false);
	const sending = useRef(false);
	useEffect(() => setPrefix(`aisa-live/${crypto.randomUUID()}`), []);
	const create = useMutation({
		mutationFn: (body: AisaCreateBody) =>
			apiFetch<AisaAnalysis>("/api/live/analyses", {
				method: "POST",
				body: JSON.stringify(body),
			}),
		retry: false,
		onSuccess: (analysis, body) =>
			router.push(aisaDetailHref(body.bitmovinAccountId, analysis.analysisId)),
		onError: () => {
			sending.current = false;
		},
	});
	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!canCreate || sending.current || !accounts.accountId) return;
		const data = new FormData(event.currentTarget);
		const value = (key: string) => String(data.get(key) ?? "").trim();
		const input =
			inputType === "RTMP"
				? { type: inputType, streamKey: value("streamKey") }
				: inputType === "HLS"
					? { type: inputType, url: value("url") }
					: {
							type: inputType,
							inputId: value("inputId"),
							...(value("streamKey") ? { streamKey: value("streamKey") } : {}),
						};
		const outputId = value("outputId");
		const parsed = aisaCreateBodySchema.safeParse({
			bitmovinAccountId: accounts.accountId,
			analysis: {
				name: value("name"),
				input,
				...(value("cloudRegion") ? { cloudRegion: value("cloudRegion") } : {}),
				...(value("encoderVersion")
					? { encoderVersion: value("encoderVersion") }
					: {}),
				recording: {
					outputs: [{ outputId, outputPath: value("recordingPath") }],
				},
				outputs: [{ outputId, outputPath: value("analysisPath") }],
			},
		});
		setInvalid(!parsed.success);
		if (!parsed.success) return;
		sending.current = true;
		create.mutate(parsed.data);
	};
	return (
		<section className="mx-auto max-w-3xl space-y-6">
			<header className="space-y-3">
				<h1 className="font-semibold text-xl text-zinc-50">
					{t("aisaLive.newAnalysis")}
				</h1>
				<AisaPreviewLinks create={false} />
			</header>
			<AisaPreviewNotice managed />
			{!canCreate ? (
				<p className="text-sm text-zinc-400">{t("aisaLive.readOnly")}</p>
			) : null}
			{canCreate ? (
				<form onSubmit={submit} className="space-y-5">
					<fieldset
						disabled={!canCreate || create.isPending}
						className="min-w-0 space-y-5"
					>
						<AisaAccountSelect state={accounts} />
						{prefix ? (
							<AisaLiveFields
								inputType={inputType}
								onInputType={setInputType}
								prefix={prefix}
							/>
						) : null}
						<p className="text-sm text-zinc-400">{t("aisaLive.createHint")}</p>
						{canCreate ? (
							<Button
								type="submit"
								disabled={
									!prefix ||
									!accounts.accountId ||
									accounts.accounts.isError ||
									create.isPending ||
									create.isSuccess
								}
							>
								{t(create.isPending ? "aisaLive.creating" : "aisaLive.create")}
							</Button>
						) : null}
					</fieldset>
					{invalid ? (
						<p role="alert" className="text-sm text-red-300">
							{t("aisaLive.invalidForm")}
						</p>
					) : null}
					{create.isError ? (
						<p role="alert" className="text-sm text-red-300">
							{t("aisaLive.requestFailed")} {t("aisaLive.createUncertain")}
						</p>
					) : null}
				</form>
			) : null}
		</section>
	);
}
