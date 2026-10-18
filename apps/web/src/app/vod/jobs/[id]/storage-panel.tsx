"use client";

import type { StorageSummaries } from "@bitovp/core";
import { CopyableId } from "@/components/copyable-id";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/lib/i18n/context";

/* List each declared read and write endpoint, including muxings, manifests, quality mirrors, thumbnails, and sprites, with its role and access policy. Per-Title placeholders remain literal because they are the configured values to compare against storage. Playback controls belong to the preview rail. */
export function StoragePanel({
	summaries,
	credentialRefs,
}: {
	summaries: StorageSummaries;
	credentialRefs: Record<string, { label: string; provider: string }>;
}) {
	const { t } = useT();

	const endpointList = (
		endpoints: StorageSummaries["inputs"],
		heading: string,
	) =>
		endpoints.length === 0 ? null : (
			<>
				<h3 className="mt-4 font-medium text-xs text-zinc-400 uppercase tracking-wide">
					{heading}
				</h3>
				<ul className="mt-1 space-y-2">
					{endpoints.map((endpoint) => {
						const ref =
							endpoint.credentialId !== undefined
								? credentialRefs[endpoint.credentialId]
								: undefined;
						return (
							<li
								key={endpoint.key}
								className="rounded-md border border-zinc-800 px-3 py-2"
							>
								<div className="flex flex-wrap items-center gap-2">
									<Badge className="font-mono">{endpoint.kind}</Badge>
									<span className="min-w-0 break-all font-mono text-xs text-zinc-300">
										{endpoint.location || endpoint.key}
									</span>
									{endpoint.credentialId !== undefined ? (
										<span className="text-xs text-zinc-500">
											{ref
												? `${ref.label} (${ref.provider})`
												: t("jobDetail.deletedCredential")}
										</span>
									) : null}
								</div>
								{endpoint.paths.length > 0 ? (
									<ul className="mt-1 space-y-1">
										{endpoint.paths.map((entry) => {
											return (
												<li
													key={`${entry.role}:${entry.key}:${entry.path}`}
													className="flex flex-wrap items-center gap-2 text-xs"
												>
													<span className="text-zinc-600">{entry.role}</span>
													<CopyableId value={entry.path} />
													{entry.templated ? (
														<Badge>{t("jobDetail.templatedPath")}</Badge>
													) : null}
													{typeof entry.acl === "string" ? (
														<span className="text-zinc-500">{entry.acl}</span>
													) : null}
												</li>
											);
										})}
									</ul>
								) : null}
							</li>
						);
					})}
				</ul>
			</>
		);

	return (
		<section aria-labelledby="storage-heading" className="mt-8">
			<h2 id="storage-heading" className="font-medium text-sm text-zinc-200">
				{t("jobDetail.storageIo")}
			</h2>
			{endpointList(summaries.inputs, t("jobDetail.storageInputs"))}
			{endpointList(summaries.outputs, t("jobDetail.storageOutputs"))}
		</section>
	);
}
