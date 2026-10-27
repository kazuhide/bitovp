"use client";

import {
	buildResourceTree,
	curlForStep,
	type ResourceLink,
	type ResourceNode,
	type StepLogEntry,
} from "@bitovp/core";
import { Check, Copy } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CopyableId } from "@/components/copyable-id";
import { Badge } from "@/components/ui/badge";
import { DetailPopover } from "@/components/ui/detail-popover";
import { useT } from "@/lib/i18n/context";

const NODE_TONE: Record<StepLogEntry["status"], "neutral" | "ok" | "error"> = {
	PENDING: "neutral",
	RUNNING: "ok",
	DONE: "ok",
	FAILED: "error",
};

/** Anchor id for a step node, so cross-links can scroll to it in-page. */
export function anchorId(step: string): string {
	// Injective, for real this time: the first fix escaped '_'→'__' but kept
	// ':'→'_', and one-char separators inside underscore runs stay ambiguous
	// — review-181's F1 measured `filter:v_:x` ≡ `filter:v:_x`. The separator
	// is now the two-char '_-', which no escaped key can produce (a literal
	// '_-' encodes to '__-'), so decoding — and therefore the id — is
	// unambiguous for every key in ^[a-zA-Z0-9_-]+$.
	return `resource-${step
		.replace(/_/g, "__")
		.replace(/:/g, "_-")
		.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

/**
 * Resources tab — a bm-xray-style, cross-linked resource tree parsed PURELY
 * from the job's persisted (redacted) step log. Each node shows its op kind,
 * the copyable Bitmovin resourceId, a summary of the redacted response (or
 * "response unavailable" when the job crashed mid-step), cross-links to the
 * resources it references, and a secret-free "Copy as cURL". The cURL is built
 * from the step's persisted (already-redacted) request snapshot, so the tab
 * keeps an index of step→entry to feed curlForStep the real body.
 */
export function ResourcesTab({ entries }: { entries: StepLogEntry[] }) {
	const { t } = useT();
	const groups = useMemo(() => buildResourceTree(entries), [entries]);
	const entryByStep = useMemo(() => {
		const map = new Map<string, StepLogEntry>();
		for (const entry of entries) {
			map.set(entry.step, entry);
		}
		return map;
	}, [entries]);

	if (groups.length === 0) {
		return (
			<p className="mt-2 text-sm text-zinc-500">{t("jobDetail.noResources")}</p>
		);
	}
	return (
		<div className="mt-2 space-y-6">
			{groups.map((group) => (
				<section key={group.id}>
					<h3 className="font-medium text-xs text-zinc-400 uppercase tracking-wide">
						{group.label}
						<span className="ml-2 text-zinc-600">{group.nodes.length}</span>
					</h3>
					<ul className="mt-2 space-y-1.5">
						{group.nodes.map((node) => (
							<ResourceRow
								key={node.step}
								node={node}
								entry={entryByStep.get(node.step)}
							/>
						))}
					</ul>
				</section>
			))}
		</div>
	);
}

function ResourceRow({
	node,
	entry,
}: {
	node: ResourceNode;
	entry: StepLogEntry | undefined;
}) {
	const { t } = useT();
	// curlForStep reads kind/refs/payload.muxingKind/request — all on the source
	// entry. An entry is always present (the tree is built from the same array),
	// but guard for robustness.
	const curl = entry ? curlForStep(entry) : null;
	// The reason is a CODE from core (which is UI-free), so the copy lives here. It
	// renders as a tooltip, which is why it was the last English string on the page.
	const unavailableReason =
		curl === null
			? t("ui.curlNoStepEntry")
			: curl.ok
				? undefined
				: curl.code === "NO_ENDPOINT"
					? t("ui.curlNoEndpoint", { kind: curl.kind })
					: curl.code === "VAULT_FIELDS_OMITTED"
						? t("ui.curlVaultFieldsOmitted")
						: t("ui.curlUnresolvedPathParams", { kind: curl.kind });
	return (
		<li
			id={anchorId(node.step)}
			// Focusable as a chip-navigation TARGET only : the chip's
			// click unmounts the Overview branch, so without moving focus a
			// keyboard/SR user lands on <body> at the document top (review-181
			// I2, measured). -1 keeps it out of the tab order.
			tabIndex={-1}
			className="scroll-mt-20 rounded-md border border-zinc-800/70 px-3 py-2 focus-visible:outline-2 focus-visible:outline-emerald-500"
		>
			<div className="flex flex-wrap items-center gap-2">
				<Badge tone={NODE_TONE[node.status]}>{node.status}</Badge>
				<span className="font-mono text-xs text-zinc-300">{node.step}</span>
				<span className="text-[11px] text-zinc-600">{node.kind}</span>
				{node.resourceId ? (
					<span className="ml-auto">
						<CopyableId value={node.resourceId} label={t("ui.resourceId")} />
					</span>
				) : null}
			</div>

			{node.error ? (
				<p className="mt-1 text-red-400 text-xs">{node.error}</p>
			) : null}

			{node.responseUnavailable ? (
				<p className="mt-1 text-[11px] text-amber-400">
					{t("ui.responseUnavailableStepRanButNoResponse")}
				</p>
			) : null}

			{node.responseSummary ? (
				<dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-zinc-500">
					{Object.entries(node.responseSummary).map(([key, value]) => (
						<div key={key} className="flex gap-1">
							<dt className="text-zinc-600">{key}</dt>
							<dd className="font-mono text-zinc-400">{String(value)}</dd>
						</div>
					))}
				</dl>
			) : null}

			{node.links.length > 0 ? (
				<div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
					<span className="text-zinc-600">{t("ui.refs")}</span>
					{node.links.map((link) => (
						<CrossLink key={`${link.key}-${link.resourceId}`} link={link} />
					))}
				</div>
			) : null}

			<div className="mt-1.5 flex flex-wrap items-center gap-3">
				{curl?.ok ? (
					<CopyCurlButton command={curl.command} />
				) : (
					<span className="text-[11px] text-zinc-600" title={unavailableReason}>
						{t("ui.curlUnavailable")}
					</span>
				)}
				{/*  item 10: the persisted (already-redacted) snapshots,
				    IN PLACE — the detail lived only on the timeline tab. Either-or,
				    not both: a FAILED await carries response (stoppedSiblings) with
				    no request (review-178 I3 — under `&&` the one row an operator
				    most needs would silently lose its expander). */}
				{entry?.request !== undefined || entry?.response !== undefined ? (
					<DetailPopover
						summary={t("ui.rawSnapshots")}
						label={t("ui.rawSnapshotsLabel", { step: node.step })}
					>
						<div className="max-w-96 space-y-2">
							{entry?.request !== undefined ? (
								<SnapshotBlock
									label={t("ui.rawRequest")}
									value={entry.request}
								/>
							) : null}
							{entry?.response !== undefined ? (
								<SnapshotBlock
									label={t("ui.rawResponse")}
									value={entry.response}
								/>
							) : null}
						</div>
					</DetailPopover>
				) : null}
			</div>
		</li>
	);
}

/**
 * One labelled snapshot body. A component, not inline JSX, so the
 * JSON.stringify runs when the popover CONTENT mounts (on open) instead of
 * on every row render — inline it was ~2 pretty-prints per node per poll
 * tick (review-178 N5).
 */
function SnapshotBlock({ label, value }: { label: string; value: unknown }) {
	return (
		<div>
			<div className="mb-0.5 text-[11px] text-zinc-500">{label}</div>
			<pre className="select-all overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] text-zinc-300">
				{JSON.stringify(value, null, 2)}
			</pre>
		</div>
	);
}

/**
 * A resolved cross-link. When the producing step is known it is an in-page
 * anchor (jump to that resource node); otherwise it is a plain id label (the
 * producer is outside this log).
 */
function CrossLink({ link }: { link: ResourceLink }) {
	const { t } = useT();
	if (link.step) {
		return (
			<a
				href={`#${anchorId(link.step)}`}
				className="inline-flex items-center gap-1 rounded bg-zinc-800/60 px-1.5 py-0.5 font-mono text-emerald-400 hover:bg-zinc-800 hover:text-emerald-300"
				title={t("uiX.resourceCreatedByStep", {
					id: link.resourceId,
					step: link.step,
				})}
			>
				<span className="text-zinc-500">{link.key}</span>
				{link.resourceId}
			</a>
		);
	}
	return (
		<span className="inline-flex items-center gap-1 font-mono text-zinc-500">
			<span className="text-zinc-600">{link.key}</span>
			{link.resourceId}
		</span>
	);
}

function CopyCurlButton({ command }: { command: string }) {
	const { t } = useT();
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (timer.current) {
				clearTimeout(timer.current);
			}
		},
		[],
	);
	return (
		<button
			type="button"
			aria-label={t("jobDetail.copyAsCurl")}
			onClick={async () => {
				try {
					await navigator.clipboard.writeText(command);
				} catch {
					return; // clipboard denied (permissions/insecure context)
				}
				setCopied(true);
				if (timer.current) {
					clearTimeout(timer.current);
				}
				timer.current = setTimeout(() => setCopied(false), 1500);
			}}
			className="inline-flex items-center gap-1.5 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-800"
		>
			{copied ? (
				<Check aria-hidden className="h-3 w-3 text-emerald-400" />
			) : (
				<Copy aria-hidden className="h-3 w-3 text-zinc-500" />
			)}
			{t("jobDetail.copyAsCurl")}
		</button>
	);
}
