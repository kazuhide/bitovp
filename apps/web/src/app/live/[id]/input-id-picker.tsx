"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
	type ResourceIdCandidate,
	ResourceIdPicker,
} from "@/components/resource-id-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { localizedCustomerError } from "@/lib/customer-error";
import { useT } from "@/lib/i18n/context";
import type { InputListDto } from "@/lib/live-runtime/schemas";

/**
 * Candidate source: `GET /api/live/inputs`, i.e. Bitmovin's own account-wide
 * `encoding.inputs.list` (C24 — the one cross-type input list), drained
 * server-side.
 *
 * A Bitmovin round-trip rather than local data on purpose: this app never
 * persists the Input resources it creates — the orchestrator mints them per
 * job from stored credentials and only the step log remembers the ids — and
 * the slate/filler inputs an operator registers content against are typically
 * created outside this app entirely. Bitmovin is the only place that knows the
 * full set.
 *
 * The `type` chip carries the real decision: insertable content is DOWNLOADED
 * from the input, so a file-storage input (S3, GCS, HTTPS, …) is what works
 * here — a live ingest input (RTMP/SRT/ZIXI) has no file to fetch. The list
 * shows the type instead of filtering, because "which types can back a
 * download" is Bitmovin's answer to give, not ours to hard-code.
 */
export function InputIdPicker({
	inputId,
	bitmovinAccountId,
	value,
	onChange,
}: {
	inputId: string;
	bitmovinAccountId: string;
	value: string;
	onChange: (value: string) => void;
}) {
	const { t } = useT();
	// : server-side name search. Debounced by the query key — the
	// input drives DEFERRED state so each keystroke doesn't refetch.
	const [search, setSearch] = useState("");
	const [applied, setApplied] = useState("");
	const inputs = useQuery({
		queryKey: ["bitmovin-inputs", bitmovinAccountId, applied],
		queryFn: () =>
			apiFetch<InputListDto>(
				`/api/live/inputs?bitmovinAccountId=${bitmovinAccountId}${
					applied ? `&name=${encodeURIComponent(applied)}` : ""
				}`,
			),
	});

	const candidates: ResourceIdCandidate[] = (inputs.data?.items ?? []).map(
		(input) => ({
			id: input.id,
			label: input.name || input.id,
			...(input.type ? { badge: input.type } : {}),
		}),
	);

	return (
		<div className="space-y-2">
			<div className="flex items-center gap-2">
				<Input
					aria-label={t("ui.searchInputsByName")}
					placeholder={t("ui.searchInputsByName")}
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							setApplied(search.trim());
						}
					}}
				/>
				<Button
					type="button"
					size="sm"
					variant="secondary"
					onClick={() => setApplied(search.trim())}
				>
					{t("ui.search")}
				</Button>
			</div>
			<ResourceIdPicker
				inputId={inputId}
				value={value}
				onChange={onChange}
				candidates={candidates}
				isLoading={inputs.isLoading}
				{...(inputs.isError
					? {
							errorMessage:
								t("uiX.couldNotListInputs") +
								` ${localizedCustomerError(t, inputs.error, "common.requestFailed")}`,
						}
					: {})}
				emptyMessage={t("uiX.noInputsInAccount")}
				listLabel={t("uiX.inputsInThisAccount")}
				copyLabel={t("uiX.inputIdNoun")}
				placeholder={t("ui.inputIdOrPasteOneFromAnother")}
				{...(inputs.data?.truncated
					? {
							truncatedMessage: t("ui.showingTheFirst500InputsOnlyPaste"),
						}
					: {})}
			/>
		</div>
	);
}
