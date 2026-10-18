import type { PlaceholderRef } from "./plan-import";

/**
 *  item 3: WHICH placeholder tokens, at WHICH plan paths — the
 * form path told the user only "N placeholder paths" while the import path
 * rendered an actionable checklist. Extracted so the rendering is pinnable
 * without mounting the whole wizard. A definition list, not ul/li: the
 * token→paths RELATION is the content (review-178 N6 — KeyValueRows and the
 * job page's responseSummary already speak dl to AT for the same shape).
 */
export function PlaceholderRefsList({ refs }: { refs: PlaceholderRef[] }) {
	if (refs.length === 0) {
		return null;
	}
	return (
		<dl className="space-y-0.5 text-xs">
			{refs.map((ref) => (
				<div key={ref.token} className="flex flex-wrap gap-x-2">
					<dt className="select-all font-mono">{ref.token}</dt>
					<dd className="text-zinc-500">{ref.paths.join(", ")}</dd>
				</div>
			))}
		</dl>
	);
}
