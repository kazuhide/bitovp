"use client";

import type { EncodingPlan } from "@bitovp/core";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

export function InternalHevcV2Badge({
	plan,
}: {
	plan: EncodingPlan | undefined;
}) {
	const profile = plan?.internal?.hevcV2;
	const accounts = useQuery({
		queryKey: ["bitmovin-accounts"],
		queryFn: () =>
			apiFetch<{ id: string; internalHevcV2?: boolean }[]>(
				"/api/bitmovin-accounts",
			),
		enabled: !!profile,
	});
	if (
		!profile ||
		!accounts.data?.some(
			(account) =>
				account.id === plan?.bitmovin.accountId &&
				account.internalHevcV2 === true,
		)
	)
		return null;
	return (
		<span className="text-xs text-zinc-400">
			HEVCv2 · BCF {profile.bcfVersion}
		</span>
	);
}
