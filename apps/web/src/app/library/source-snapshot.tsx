"use client";
import type { LibrarySourceView } from "@bitovp/core";
import { useT } from "@/lib/i18n/context";

export function SourceSnapshot({ source }: { source: LibrarySourceView }) {
	const { t } = useT();
	const snapshot = source.snapshot;
	const verdict = snapshot.qcVerdict;
	const pass =
		verdict && typeof verdict === "object" && "pass" in verdict
			? verdict.pass
			: undefined;
	return (
		<details className="rounded-md border border-zinc-800 p-3">
			<summary className="cursor-pointer text-sm">
				{t("library.qcSnapshot")}
			</summary>
			<p className="mt-3 text-xs text-zinc-400">
				{t("library.qcSnapshotNotice")}
			</p>
			<p className="my-2 text-sm">
				{t("jobDetail.qcGateResult")}:{" "}
				{t(
					pass === true
						? "jobs.qcPass"
						: pass === false
							? "jobs.qcFail"
							: "jobDetail.qcGateNoVerdict",
				)}
			</p>
			<pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">
				{JSON.stringify(
					{
						originalJobId: source.originalJobId,
						name: snapshot.name,
						planHash: snapshot.planHash,
						inputs: snapshot.inputs,
						qcVerdict: verdict ?? null,
						qcOverriddenAt: snapshot.qcOverriddenAt,
						qcEvidence: snapshot.qcEvidence ?? [],
					},
					null,
					2,
				)}
			</pre>
		</details>
	);
}
