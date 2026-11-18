"use client";

import { useQuery } from "@tanstack/react-query";
import { useDocumentOrganization } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import {
	type MoqReadinessTarget,
	moqReadinessSchema,
} from "@/lib/moq-player/readiness";

export function useMoqPreviewReadiness(
	target?: MoqReadinessTarget,
	generation?: number,
) {
	const organization = useDocumentOrganization();
	const params = target
		? new URLSearchParams(
				"channelId" in target
					? { channelId: target.channelId }
					: {
							credentialId: target.credentialId,
							draftVersion: target.draftVersion,
							namespaceComponents: String(target.namespaceComponents),
						},
			).toString()
		: null;
	const query = useQuery({
		queryKey: ["moq-preview-readiness", organization, params, generation],
		enabled: params !== null,
		retry: false,
		networkMode: "always",
		staleTime: 0,
		refetchOnMount: "always",
		refetchOnWindowFocus: true,
		queryFn: async ({ signal }) => {
			const result = await apiFetch<unknown>(
				`/api/live-channels/moq-readiness?${params}`,
				{
					cache: "no-store",
					signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
				},
			);
			return moqReadinessSchema.parse(result);
		},
	});
	const checking = params !== null && (query.isPending || query.isFetching);
	return {
		checking,
		result: checking || query.isError ? undefined : query.data,
		recheck: () => void query.refetch(),
	};
}

export function MoqPreviewReadiness({
	checking,
	result,
	recheck,
}: ReturnType<typeof useMoqPreviewReadiness>) {
	const { t } = useT();
	const label = checking ? "checking" : (result?.status ?? "unavailable");
	return (
		<div className="space-y-1 rounded-md border border-zinc-800 px-3 py-2 text-xs">
			<p role="status" className="font-medium text-zinc-200">
				{t(`moqReadiness.${label}`)}
			</p>
			{result?.issues.length ? (
				<ul className="list-inside list-disc text-zinc-300">
					{result.issues.map((issue) => (
						<li key={issue}>{t(`moqReadiness.${issue}`)}</li>
					))}
				</ul>
			) : null}
			{checking ? null : (
				<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
					<p className="text-zinc-400">{t("moqReadiness.advisory")}</p>
					<Button
						variant="ghost"
						size="sm"
						onClick={recheck}
						className="h-6 px-2 text-zinc-200"
					>
						{t("moqReadiness.recheck")}
					</Button>
				</div>
			)}
		</div>
	);
}
