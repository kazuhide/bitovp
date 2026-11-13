"use client";

import type { ContentView } from "@bitovp/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArchiveRestore, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ApiError, apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";

/** Archive the registration while retaining media, edits and publication lineage. */
export function ContentRemovalAction({
	content,
	onChanged,
	className,
}: {
	content: Pick<ContentView, "id" | "title" | "revision" | "archived">;
	onChanged?: () => void;
	className?: string;
}) {
	const { t } = useT();
	const canManage = useMutationAccess("library.content.remove");
	const client = useQueryClient();
	const [open, setOpen] = useState(false);
	const mutation = useMutation({
		mutationFn: () =>
			apiFetch(`/api/library/${content.id}`, {
				method: "PATCH",
				body: JSON.stringify({
					expectedRevision: content.revision,
					archived: !content.archived,
				}),
			}),
		onSuccess: () => {
			setOpen(false);
			onChanged?.();
			void client.invalidateQueries({ queryKey: ["library"] });
			void client.invalidateQueries({ queryKey: ["library-scene-options"] });
			void client.invalidateQueries({ queryKey: ["job-analysis"] });
		},
	});
	const label = t(content.archived ? "library.restore" : "library.remove");
	const aria = t(
		content.archived ? "library.restoreAria" : "library.removeAria",
		{ title: content.title },
	);
	const error = mutation.error
		? mutation.error instanceof ApiError && mutation.error.status === 409
			? t("library.conflict")
			: mutation.error instanceof ApiError && mutation.error.status === 403
				? t("library.permissionDenied")
				: mutation.error.message
		: null;
	return canManage ? (
		<div className={className}>
			<Button
				variant="ghost"
				size="sm"
				aria-label={aria}
				title={label}
				disabled={mutation.isPending}
				onClick={() => {
					mutation.reset();
					setOpen(true);
				}}
			>
				{content.archived ? (
					<ArchiveRestore className="size-4" aria-hidden="true" />
				) : (
					<Trash2 className="size-4" aria-hidden="true" />
				)}
			</Button>
			<Dialog
				open={open}
				onOpenChange={setOpen}
				title={t(
					content.archived ? "library.restoreTitle" : "library.removeTitle",
					{ title: content.title },
				)}
				description={t(
					content.archived
						? "library.restoreDescription"
						: "library.removeDescription",
				)}
			>
				{error && (
					<p role="alert" className="mb-3 text-red-400 text-sm">
						{error}
					</p>
				)}
				<div className="flex flex-wrap justify-end gap-2">
					<Button
						variant="secondary"
						size="sm"
						disabled={mutation.isPending}
						onClick={() => setOpen(false)}
					>
						{t("common.cancel")}
					</Button>
					<Button
						variant={content.archived ? "secondary" : "destructive"}
						size="sm"
						disabled={mutation.isPending}
						onClick={() => mutation.mutate()}
					>
						{mutation.isPending ? t("common.saving") : label}
					</Button>
				</div>
			</Dialog>
		</div>
	) : null;
}
