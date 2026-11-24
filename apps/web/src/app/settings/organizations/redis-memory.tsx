"use client";

import { useQuery } from "@tanstack/react-query";
import type { RedisMemory } from "@/app/api/platform/redis-memory/route";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { useT } from "@/lib/i18n/context";

export function InstanceRedisMemory() {
	const { t } = useT();
	const query = useQuery({
		queryKey: ["platform", "redis-memory"],
		queryFn: ({ signal }) =>
			apiFetch<RedisMemory>("/api/platform/redis-memory", {
				signal,
				cache: "no-store",
			}),
		gcTime: 0,
		staleTime: 0,
		retry: false,
	});
	let reading = t("common.loading");
	if (query.isError) {
		reading = t("tenant.redisUnavailable");
	} else if (query.isSuccess) {
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
