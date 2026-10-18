import { Download } from "lucide-react";

/**
 * Export buttons → the full (non-downsampled) per-frame export route. Plain
 * anchors with `download` so the browser streams the file straight to disk;
 * no client-side fetch/blob plumbing needed. `resultId` scopes the export to
 * a single rendition when provided.
 */
export function ExportButtons({
	jobId,
	resultId,
}: {
	jobId: string;
	resultId?: string;
}) {
	const base = `/api/vmaf-jobs/${jobId}/export`;
	const suffix = resultId ? `&result=${resultId}` : "";
	const cls =
		"inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-800";
	return (
		<div className="flex items-center gap-2">
			<a className={cls} href={`${base}?format=json${suffix}`} download>
				<Download className="h-3.5 w-3.5" aria-hidden="true" />
				JSON
			</a>
			<a className={cls} href={`${base}?format=csv${suffix}`} download>
				<Download className="h-3.5 w-3.5" aria-hidden="true" />
				CSV
			</a>
		</div>
	);
}
