"use client";

import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useSession } from "@/lib/auth/use-session";
import { formatBytes } from "@/lib/format";
import { useT } from "@/lib/i18n/context";
import { redisMemorySchema } from "@/lib/platform-redis-memory";

export function PlatformRedisMemory() {
	const session = useSession();
	if (
		session.status !== "success" ||
		session.data.mode !== "users" ||
		!session.data.authenticated ||
		session.data.platformOwner !== true ||
		session.data.isImpersonating ||
		session.data.mustChangePassword
	)
		return null;
	return <InstanceRedisMemory />;
}

function InstanceRedisMemory() {
	const { t } = useT();
	const query = useQuery({
		queryKey: ["platform", "redis-memory"],
		queryFn: async ({ signal }) =>
			redisMemorySchema.parse(
				await apiFetch<unknown>("/api/platform/redis-memory", {
					signal,
					cache: "no-store",
				}),
			),
		gcTime: 0,
		staleTime: 0,
		retry: false,
		// Allow an offline refresh to reject instead of pausing on cached data.
		networkMode: "always",
	});
	let reading = t("common.loading");
	if (query.isError) {
		reading = t("tenant.redisUnavailable");
	} else if (query.isSuccess && !query.isFetching) {
		const used = formatBytes(query.data.usedBytes);
		reading =
			query.data.limitBytes === null
				? t("tenant.redisUnlimited", { used })
				: t("tenant.redisCapped", {
						used,
						limit: formatBytes(query.data.limitBytes),
					});
	}
	return (
		<section
			aria-labelledby="instance-redis-memory"
			className="mt-6 rounded-lg border border-zinc-800 px-4 py-3"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h2
					id="instance-redis-memory"
					className="text-sm font-medium text-zinc-200"
				>
					{t("tenant.redisMemory")}
				</h2>
				<Button
					size="sm"
					variant="secondary"
					disabled={query.isFetching}
					onClick={() => void query.refetch()}
				>
					{t("common.refresh")}
				</Button>
			</div>
			<p role="status" className="mt-1 text-sm text-zinc-400">
				{reading}
			</p>
		</section>
	);
}
