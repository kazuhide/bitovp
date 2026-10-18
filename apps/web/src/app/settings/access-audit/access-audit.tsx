"use client";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/ui/info-hint";
import { apiFetch } from "@/lib/api";
import { useSession } from "@/lib/auth/use-session";
import { useT } from "@/lib/i18n/context";
import { IpPolicy } from "../organizations/ip-policy";
import { SettingsBreadcrumb } from "../settings-breadcrumb";

type Event = {
	id: string;
	userDisplayName: string;
	actor: string;
	method: string;
	path: string;
	clientIp: string | null;
	statusCode: number;
	createdAt: string;
};
type Events = { events: Event[]; nextCursor: string | null };
export function AccessAudit() {
	const { t, locale } = useT();
	const session = useSession();
	const organizationId =
		session.status === "success" ? session.data.organizationId : undefined;
	const query = useInfiniteQuery({
		queryKey: ["access-events", organizationId],
		enabled: Boolean(organizationId),
		initialPageParam: null as string | null,
		queryFn: ({ pageParam }) =>
			apiFetch<Events>(
				`/api/access-events${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ""}`,
			),
		getNextPageParam: (last) => last.nextCursor ?? undefined,
	});
	const events = query.data?.pages.flatMap((page) => page.events) ?? [];
	return (
		<section>
			<SettingsBreadcrumb />
			<div className="flex items-center gap-2">
				<h1 className="font-semibold text-xl text-zinc-50">
					{t("tenant.accessAudit")}{" "}
				</h1>
				<InfoHint
					text={t("tenant.historyHelp")}
					labelFor={t("tenant.accessAudit")}
				/>
			</div>
			{organizationId ? <IpPolicy organizationId={organizationId} /> : null}
			{query.isPending ? (
				<p className="mt-5 text-sm text-zinc-400" role="status">
					{t("tenant.loading")}
				</p>
			) : null}
			{query.error ? (
				<p className="mt-5 text-sm text-red-400" role="alert">
					{query.error.message}
				</p>
			) : null}
			{query.isSuccess && !events.length ? (
				<p className="mt-5 text-sm text-zinc-400">{t("tenant.noHistory")}</p>
			) : null}
			{events.length ? (
				<div className="mt-6 overflow-x-auto rounded-md border border-zinc-800">
					<table className="w-full text-left text-sm">
						<thead className="bg-zinc-900 text-zinc-400">
							<tr>
								{["when", "who", "path", "ip", "decision"].map((key) => (
									<th key={key} scope="col" className="px-3 py-2">
										{t(`tenant.${key}` as "tenant.when")}
									</th>
								))}
							</tr>
						</thead>
						<tbody className="divide-y divide-zinc-800">
							{events.map((event) => (
								<tr key={event.id}>
									<td className="whitespace-nowrap px-3 py-2">
										<time dateTime={event.createdAt}>
											{new Date(event.createdAt).toLocaleString(locale)}
										</time>
									</td>
									<td className="px-3 py-2" title={event.actor}>
										{event.userDisplayName}
									</td>
									<td className="max-w-80 break-all px-3 py-2">
										<span className="mr-2 text-xs text-zinc-500">
											{event.method}
										</span>
										{event.path}
									</td>
									<td className="px-3 py-2 font-mono text-xs">
										{event.clientIp ?? "—"}
									</td>
									<td className="px-3 py-2">
										{t(
											event.statusCode < 400
												? "tenant.allowed"
												: "tenant.denied",
										)}{" "}
										({event.statusCode})
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : null}
			{query.hasNextPage ? (
				<Button
					className="mt-4"
					variant="secondary"
					onClick={() => query.fetchNextPage()}
					disabled={query.isFetchingNextPage}
				>
					{t("tenant.more")}
				</Button>
			) : null}
		</section>
	);
}
