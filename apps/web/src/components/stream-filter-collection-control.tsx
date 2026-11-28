"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Input } from "./ui/input";

const labels = {
	en: {
		open: "Remove all filter attachments",
		remove: "Remove all attachments",
		id: "Stream ID",
		description:
			"This clears every filter attached to the stream when Bitmovin runs the deletion. Enter the stream ID to confirm.",
		empty: "No filter attachments.",
		blocked:
			"The stream contains attachments outside this job. Collection removal is unavailable.",
		complete: "Filter attachment collection cleared.",
		stillPresent: "The provider still lists filter attachments.",
	},
	ja: {
		open: "フィルターの関連付けを一括解除",
		remove: "すべて解除",
		id: "ストリームID",
		description:
			"Bitmovin が処理する時点で、ストリームに付いているすべてのフィルターを解除します。ストリームIDを入力して確定してください。",
		empty: "フィルターの関連付けはありません。",
		blocked:
			"このジョブに記録されていない関連付けがあるため、一括解除できません。",
		complete: "フィルターの関連付けをすべて解除しました。",
		stillPresent: "フィルターの関連付けが残っています。",
	},
};

export function StreamFilterCollectionControl({
	endpoint,
	stream,
}: {
	endpoint: string;
	stream: { id: string; step: string; attempt: number };
}) {
	const { locale, t } = useT();
	const text = labels[locale];
	const client = useQueryClient();
	const inputId = useId();
	const [open, setOpen] = useState(false);
	const [typed, setTyped] = useState("");
	const [removed, setRemoved] = useState(false);
	const params = new URLSearchParams({
		step: stream.step,
		attempt: String(stream.attempt),
		view: "filterCollection",
	});
	const preview = useQuery({
		queryKey: ["provider-resources", endpoint, stream.id, params.toString()],
		queryFn: ({ signal }) =>
			apiFetch<{ filterIds: string[]; pending: boolean; blocked?: boolean }>(
				`${endpoint}?${params}`,
				{ signal },
			),
		enabled: open,
		retry: false,
	});
	const action = useMutation({
		mutationFn: (filterIds: string[] | undefined) =>
			apiFetch<{ state: string; disposition: string }>(endpoint, {
				method: filterIds ? "DELETE" : "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					step: stream.step,
					attempt: stream.attempt,
					confirmResourceId: stream.id,
					filters: filterIds
						? { mode: "collection", filterIds }
						: { mode: "collection" },
					...(filterIds && { retry: true }),
				}),
			}),
		onSuccess: (result) => {
			setTyped("");
			if (result.state === "REMOVED") {
				setRemoved(true);
				setOpen(false);
			}
		},
		onSettled: () =>
			client.invalidateQueries({ queryKey: ["provider-resources", endpoint] }),
	});
	const ids = preview.data?.filterIds ?? [];
	return (
		<div className="space-y-2 border-t border-zinc-800 pt-3">
			<Button
				type="button"
				variant="secondary"
				size="sm"
				onClick={() => {
					action.reset();
					setRemoved(false);
					setOpen(true);
				}}
			>
				{text.open}
			</Button>
			{removed && (
				<p role="status" className="text-xs">
					{text.complete}
				</p>
			)}
			<Dialog
				open={open}
				onOpenChange={(next) => {
					if (!action.isPending) {
						setTyped("");
						setOpen(next);
					}
				}}
				title={text.open}
				description={text.description}
			>
				<div className="space-y-3 text-sm">
					{preview.isFetching && (
						<p role="status">{t("providerResources.loading")}</p>
					)}
					{preview.isError && (
						<div className="space-y-2">
							<p role="alert">{t("providerResources.failed")}</p>
							<Button
								type="button"
								variant="secondary"
								size="sm"
								onClick={() => preview.refetch()}
							>
								{t("common.retry")}
							</Button>
						</div>
					)}
					{preview.isSuccess &&
						(preview.data.blocked ? (
							<p role="status">{text.blocked}</p>
						) : ids.length === 0 ? (
							<p role="status">{text.empty}</p>
						) : (
							<>
								<ul className="max-h-36 list-inside list-disc overflow-auto font-mono text-xs">
									{ids.map((id) => (
										<li key={id} className="break-all">
											{id}
										</li>
									))}
								</ul>
								<p className="break-all font-mono text-xs">{stream.id}</p>
								<label className="block" htmlFor={inputId}>
									{text.id}
								</label>
								<Input
									id={inputId}
									autoComplete="off"
									value={typed}
									onChange={(event) => setTyped(event.target.value)}
								/>
								<Button
									type="button"
									variant="destructive"
									size="sm"
									disabled={
										typed !== stream.id ||
										preview.isFetching ||
										action.isPending
									}
									onClick={() => {
										setTyped("");
										action.mutate(ids);
									}}
								>
									{text.remove}
								</Button>
							</>
						))}
					{preview.data?.pending && (
						<Button
							type="button"
							variant="secondary"
							size="sm"
							disabled={action.isPending}
							onClick={() => action.mutate(undefined)}
						>
							{t("providerResources.verify")}
						</Button>
					)}
					{action.data?.disposition === "present" && (
						<p role="status">{text.stillPresent}</p>
					)}
					{action.isError && (
						<p role="alert">{t("providerResources.removeFailed")}</p>
					)}
				</div>
			</Dialog>
		</div>
	);
}
