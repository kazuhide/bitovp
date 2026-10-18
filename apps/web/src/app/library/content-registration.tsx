"use client";
import type { ContentView, LibrarySourceView } from "@bitovp/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, SelectNative } from "@/components/ui/input";
import { ApiError, apiFetch } from "@/lib/api";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";
import {
	type EditorialValues,
	editorialPayload,
	MetadataFields,
} from "./metadata-fields";
export function ContentRegistration({ source }: { source: LibrarySourceView }) {
	const { t } = useT();
	const id = useId();
	const canRegister = useMutationAccess("library.content.register");
	const client = useQueryClient();
	const [search, setSearch] = useState("");
	const [target, setTarget] = useState<ContentView | null>(null);
	const initial = source.analyses[0];
	const [value, setValue] = useState<EditorialValues>({
		title: initial?.document.title || source.snapshot.name,
		description: initial?.document.description.slice(0, 10000) ?? "",
		tags: "",
		locale: initial?.locale ?? "en",
	});
	const choices = useQuery({
		queryKey: ["library", "register", search],
		queryFn: () =>
			apiFetch<{ items: ContentView[] }>(
				`/api/library?${new URLSearchParams({ q: search, archived: "false" })}`,
			),
		enabled: canRegister,
	});
	const mutation = useMutation({
		mutationFn: () =>
			apiFetch<ContentView>("/api/library", {
				method: "POST",
				body: JSON.stringify({
					sourceId: source.id,
					...editorialPayload(value),
					...(target
						? { contentId: target.id, expectedRevision: target.revision }
						: {}),
				}),
			}),
		onSuccess: () => {
			void client.invalidateQueries({ queryKey: ["library"] });
			void client.invalidateQueries({ queryKey: ["job-analysis"] });
		},
	});
	return canRegister ? (
		<details className="rounded-md border border-zinc-800 p-4">
			<summary className="cursor-pointer font-medium">
				{t("library.register")}
			</summary>
			<form
				className="mt-4 space-y-4"
				onSubmit={(e) => {
					e.preventDefault();
					mutation.mutate();
				}}
			>
				<label htmlFor={`${id}-search`} className="block space-y-1 text-sm">
					{t("library.search")}
					<Input
						id={`${id}-search`}
						type="search"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
					/>
				</label>
				<label htmlFor={`${id}-target`} className="block space-y-1 text-sm">
					{t("library.destination")}
					<SelectNative
						id={`${id}-target`}
						value={target?.id ?? ""}
						onChange={(e) => {
							const item =
								choices.data?.items.find(
									(item) => item.id === e.target.value,
								) ?? null;
							setTarget(item);
							if (item)
								setValue({
									title: item.title,
									description: item.description,
									locale: item.locale,
									tags: item.tags.join(", "),
								});
						}}
					>
						<option value="">{t("library.newContent")}</option>
						{target &&
							!choices.data?.items.some((item) => item.id === target.id) && (
								<option value={target.id}>{target.title}</option>
							)}
						{choices.data?.items.map((item) => (
							<option key={item.id} value={item.id}>
								{item.title}
							</option>
						))}
					</SelectNative>
				</label>
				{choices.error && <p role="alert">{choices.error.message}</p>}
				<MetadataFields
					value={value}
					onChange={setValue}
					locales={source.locales}
				/>
				<Button
					type="submit"
					disabled={mutation.isPending || !value.title.trim() || !value.locale}
				>
					{t("library.register")}
				</Button>
				{mutation.error && (
					<p role="alert">
						{mutation.error instanceof ApiError && mutation.error.status === 409
							? t("library.conflict")
							: mutation.error.message}
					</p>
				)}
				{mutation.data && (
					<p role="status">
						<Link
							href={`/library/${mutation.data.id}`}
							className="text-emerald-400 underline"
						>
							{t("library.registerSuccess")}
						</Link>
					</p>
				)}
			</form>
		</details>
	) : null;
}
