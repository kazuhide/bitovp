"use client";

import type { SceneAnalysisDocument } from "@bitovp/core";
import { useT } from "@/lib/i18n/context";

export function ContentCredits({
	credits,
}: {
	credits: SceneAnalysisDocument["credits"];
}) {
	const { t } = useT();
	const persons = credits?.persons ?? [];
	const songs = credits?.songs ?? [];
	return (
		<section
			aria-label={t("library.contentCredits")}
			className="space-y-2 rounded-md border border-zinc-800 p-3 text-sm"
		>
			<h3 className="font-semibold">{t("library.contentCredits")}</h3>
			{persons.length > 0 && (
				<details>
					<summary className="cursor-pointer font-medium">
						{t("library.creditPersons")} ({persons.length})
					</summary>
					<ul className="mt-2 max-h-80 space-y-2 overflow-auto">
						{persons.map((person, index) => (
							<li key={`${person.name}-${index}`} className="break-words">
								<strong>{person.name || t("library.unreported")}</strong>
								<dl className="grid grid-cols-[auto_1fr] gap-x-2 text-zinc-400">
									<dt>{t("library.creditRole")}</dt>
									<dd>{person.role || t("library.unreported")}</dd>
									<dt>{t("library.creditDepartment")}</dt>
									<dd>{person.department || t("library.unreported")}</dd>
								</dl>
							</li>
						))}
					</ul>
				</details>
			)}
			{songs.length > 0 && (
				<details>
					<summary className="cursor-pointer font-medium">
						{t("library.creditSongs")} ({songs.length})
					</summary>
					<ul className="mt-2 max-h-80 space-y-2 overflow-auto">
						{songs.map((song, index) => (
							<li key={`${song.name}-${index}`} className="break-words">
								<strong>{song.name || t("library.unreported")}</strong>
								<dl className="grid grid-cols-[auto_1fr] gap-x-2 text-zinc-400">
									<dt>{t("library.creditArtist")}</dt>
									<dd>{song.artist || t("library.unreported")}</dd>
								</dl>
							</li>
						))}
					</ul>
				</details>
			)}
			{credits?.copyright && (
				<dl>
					<dt className="text-zinc-400">{t("library.creditCopyright")}</dt>
					<dd className="whitespace-pre-wrap break-words">
						{credits.copyright}
					</dd>
				</dl>
			)}
			{persons.length === 0 && songs.length === 0 && !credits?.copyright && (
				<p className="text-zinc-400">{t("library.unreported")}</p>
			)}
		</section>
	);
}
