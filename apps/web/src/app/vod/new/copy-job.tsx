"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import { VodWizard } from "./wizard";

/** Fetch once before mounting an editable form; later cache refreshes cannot reset edits. */
export function CopyVodJob({
	source,
	conflictingSource = false,
}: {
	source?: string | string[];
	conflictingSource?: boolean;
}) {
	const { t } = useT();
	const valid = !conflictingSource && z.uuid().safeParse(source).success;
	const [copied, setCopied] = useState<{
		id: string;
		plan: Record<string, unknown>;
		repairedBitrate: boolean;
	} | null>(null);
	const job = useQuery({
		queryKey: ["encoding-job-copy", source],
		enabled: valid && copied === null,
		retry: false,
		queryFn: async () => {
			const value = await apiFetch<{ plan?: unknown }>(
				`/api/encoding-jobs/${source}`,
			);
			if (
				!value.plan ||
				typeof value.plan !== "object" ||
				Array.isArray(value.plan)
			)
				throw new Error("Missing source plan");
			const sourcePlan = value.plan as Record<string, unknown>;
			let repairedBitrate = false;
			const renditions = Array.isArray(sourcePlan.renditions)
				? sourcePlan.renditions.map((row: unknown) => {
						if (!row || typeof row !== "object" || Array.isArray(row))
							return row;
						const rendition = row as Record<string, unknown>;
						if (
							["H264", "H265", "VP9", "AV1"].includes(
								String(rendition.codec),
							) &&
							typeof rendition.mode === "string" &&
							rendition.mode.startsWith("PER_TITLE") &&
							typeof rendition.bitrate === "number"
						) {
							repairedBitrate = true;
							return { ...rendition, bitrate: null };
						}
						return row;
					})
				: sourcePlan.renditions;
			return {
				id: source as string,
				plan: repairedBitrate ? { ...sourcePlan, renditions } : sourcePlan,
				repairedBitrate,
			};
		},
	});
	if (valid && copied === null && job.isSuccess && job.fetchStatus === "idle")
		setCopied(job.data);
	if (valid && copied && copied.id === source)
		return (
			<>
				{copied.repairedBitrate ? (
					<p role="status" className="mb-3 text-amber-200 text-sm">
						{t("wizard.copiedPerTitleBitrateFixed")}
					</p>
				) : null}
				<VodWizard copiedJob={copied} />
			</>
		);
	return (
		<section className="space-y-4">
			<h1 className="font-semibold text-xl text-zinc-50">
				{t("jobDetail.copyAndEdit")}
			</h1>
			{!valid || job.isError ? (
				<>
					<p role="alert" className="text-red-400 text-sm">
						{t("wizard.copySourceFailed")}
					</p>
					{valid ? (
						<Button variant="secondary" onClick={() => job.refetch()}>
							{t("common.retry")}
						</Button>
					) : null}
				</>
			) : (
				<p role="status" className="text-sm text-zinc-400">
					{t("common.loading")}
				</p>
			)}
		</section>
	);
}
