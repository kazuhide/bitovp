"use client";

import { effectiveLivePlanForRun } from "@bitovp/core";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import {
	InspectDialog,
	type InspectTarget,
} from "@/app/storage/inspect-dialog";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useRoleAccess } from "@/lib/auth/use-role-access";
import { localizedCustomerError } from "@/lib/customer-error";
import { useT } from "@/lib/i18n/context";

/** Storage inspection is explicit and bounded; a planned filename is not proof of generation. */
export function LiveArchivePanel({
	plan,
	run,
}: {
	plan: unknown;
	run: { id: string; seq: number; outputPrefix: string; status: string } | null;
}) {
	const { t } = useT();
	const allowed = useRoleAccess("OPERATOR");
	const [target, setTarget] = useState<InspectTarget | null>(null);
	const inspect = useMutation({
		mutationFn: async (location: InspectTarget) => {
			// One exact-key-prefix page, only on click. The bounded probe needs
			// the listed size to aim at the true tail of a finalized MP4.
			const params = new URLSearchParams({
				bucket: location.bucket,
				prefix: location.objectKey,
				limit: "100",
			});
			const page = await apiFetch<{ objects: { key: string; size: number }[] }>(
				`/api/credentials/${location.credentialId}/storage/objects?${params}`,
				{ signal: AbortSignal.timeout(15_000) },
			);
			const matches = page.objects.filter(
				(object) => object.key === location.objectKey,
			);
			const size = matches[0]?.size;
			if (
				matches.length !== 1 ||
				size === undefined ||
				!Number.isSafeInteger(size) ||
				size <= 0
			)
				throw new Error("Archive size unavailable");
			return { ...location, objectSize: size };
		},
		onSuccess: setTarget,
	});
	const effective = run ? effectiveLivePlanForRun(plan, run) : null;
	if (!allowed || !effective) return null;
	const archives = effective.muxings.filter((m) => m.kind === "MP4");
	if (!archives.length) return null;
	const targets = archives.flatMap((m) =>
		[
			...new Set([
				m.destination?.outputKey,
				...(effective.deliveryMirrors ?? []).map((o) => o.outputKey),
			]),
		].flatMap((key) => {
			const output = effective.outputs.find((o) => o.key === key);
			if (
				!output ||
				!["S3", "GENERIC_S3", "GCS", "AZURE"].includes(output.kind) ||
				!("bucket" in output) ||
				!m.destination
			)
				return [];
			const path = m.destination.path.replace(/^\/+|\/+$/g, "");
			return [
				{
					credentialId: output.credentialId,
					bucket: output.bucket,
					objectKey: path ? `${path}/${m.filename}` : m.filename,
					filename: m.filename,
				},
			];
		}),
	);
	return (
		<section
			className="mt-4 space-y-2 border-t border-zinc-800 pt-4"
			aria-label={t("liveArchive.title")}
		>
			<h4 className="font-medium text-sm text-zinc-200">
				{t("liveArchive.title")}
			</h4>
			<p className="text-xs text-zinc-400">
				{t("liveArchive.verifyAfterStop")}
			</p>
			{inspect.isError ? (
				<p role="alert" className="text-xs text-red-400">
					{localizedCustomerError(t, inspect.error, "storage.listFailed")}
				</p>
			) : null}
			<ul className="space-y-2">
				{targets.map(({ filename, ...location }) => (
					<li
						key={`${location.credentialId}:${location.bucket}:${location.objectKey}`}
						className="flex flex-wrap items-center justify-between gap-2"
					>
						<span className="min-w-0 break-all text-sm text-zinc-300">
							{location.bucket}/{location.objectKey}
						</span>
						<Button
							size="sm"
							variant="secondary"
							disabled={run?.status !== "STOPPED" || inspect.isPending}
							aria-label={`${t("storage.inspect")} ${filename}`}
							onClick={() => inspect.mutate(location)}
						>
							{t(inspect.isPending ? "common.loading" : "storage.inspect")}
						</Button>
					</li>
				))}
			</ul>
			<InspectDialog target={target} onClose={() => setTarget(null)} />
		</section>
	);
}
