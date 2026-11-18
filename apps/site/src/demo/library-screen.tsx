import type { ContentDetail } from "@bitovp/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { lazy } from "react";
import { ContentDetailClient } from "@/app/library/[id]/content-detail";
import {
	type EditingEligibility,
	type NewEditingProject,
	ProjectCreation,
} from "@/app/library/[id]/edits/editing-forms";
import { ClipProjects } from "@/app/library/clip-projects";
import { GenerationHistory } from "@/app/library/generations/generation-history";
import { LibraryClient } from "@/app/library/library-client";
import { readLibraryBrowseState } from "@/app/library/library-view-preference";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import type { AnyEditingProjectView } from "@/lib/library-editing";
import { readGenerationHistoryFilters } from "@/lib/library-generation-history";
import { readLibrarySceneSelection } from "@/lib/library-scenes";
import Link from "../shims/link";
import { demoHref, replaceDemoBrowseUrl, useRouter } from "../shims/navigation";

const EditorRouter = lazy(() =>
	import("@/app/library/edits/[id]/editor-router").then((module) => ({
		default: module.EditorRouter,
	})),
);

function demoBrowseLocation(path: string) {
	return () => {
		const href = demoHref(path);
		const { hash, pathname, search } = window.location;
		// A hash link can fire popstate before the previous screen unmounts.
		if (hash !== href && !hash.startsWith(`${href}?`)) return null;
		return {
			pathname: pathname + search + href,
			search: hash.slice(href.length),
			replaceUrl: replaceDemoBrowseUrl,
		};
	};
}
const libraryLocation = demoBrowseLocation("/library");
const historyLocation = demoBrowseLocation("/library/generations");

function SampleProjects({ contentId }: { contentId: string }) {
	const { t } = useT();
	const router = useRouter();
	const content = useQuery({
		queryKey: ["library", contentId],
		queryFn: ({ signal }) =>
			apiFetch<ContentDetail>(`/api/library/${contentId}`, { signal }),
	});
	const sourceId = content.data?.source.id;
	const eligibility = useQuery({
		queryKey: ["library-edit-eligibility", sourceId],
		queryFn: ({ signal }) =>
			apiFetch<EditingEligibility>(
				`/api/library/sources/${sourceId}/editing-eligibility`,
				{ signal },
			),
		enabled: !!sourceId,
	});
	const create = useMutation({
		mutationFn: (input: NewEditingProject) =>
			apiFetch<AnyEditingProjectView>("/api/library/edits", {
				method: "POST",
				body: JSON.stringify({ contentId, ...input }),
			}),
		onSuccess: (project) => router.push(`/library/edits/${project.id}`),
	});
	const error = content.error ?? eligibility.error ?? create.error;
	return (
		<div className="mx-auto max-w-6xl space-y-5">
			<Link
				href={`/library/${contentId}`}
				className="text-emerald-400 text-sm underline"
			>
				{t("editing.backContent")}
			</Link>
			<h1 className="font-semibold text-2xl">
				{content.data?.title ?? t("editing.projects")}
			</h1>
			{error && <p role="alert">{error.message}</p>}
			<ClipProjects
				contentId={contentId}
				showCreate={false}
				clipEditingAvailable
			/>
			{(content.isLoading || eligibility.isLoading) && (
				<p role="status">{t("editing.loading")}</p>
			)}
			{content.data && !content.data.archived && eligibility.data && (
				<ProjectCreation
					initialTitle={content.data.title}
					eligibility={eligibility.data}
					disabled={create.isPending}
					onCreate={(input) => create.mutate(input)}
				/>
			)}
		</div>
	);
}

export default function LibraryScreen({ url }: { url: URL }) {
	const { locale } = useT();
	const path = url.pathname;
	const params = Object.fromEntries(url.searchParams);
	if (path === "/library")
		return (
			<LibraryClient
				initialQuery={readLibraryBrowseState(params)}
				browseLocation={libraryLocation}
				clipEditingAvailable
			/>
		);
	if (path === "/library/generations")
		return (
			<GenerationHistory
				initialFilters={readGenerationHistoryFilters(params)}
				browseLocation={historyLocation}
				clipEditingAvailable
			/>
		);
	const editor = /^\/library\/edits\/([^/]+)$/.exec(path);
	if (editor?.[1])
		return (
			<EditorRouter
				id={editor[1]}
				previewUnavailableMessage={
					locale === "ja"
						? "下書きはページを再読み込みするまで保持されます。動画プレビューと書き出しはインストール版で利用できます。"
						: "Draft changes are kept until you reload the page. Video preview and export are available in the installed app."
				}
			/>
		);
	const projects = /^\/library\/([^/]+)\/edits$/.exec(path);
	if (projects?.[1]) return <SampleProjects contentId={projects[1]} />;
	const detail = /^\/library\/([^/]+)$/.exec(path);
	if (detail?.[1])
		return (
			<ContentDetailClient
				id={detail[1]}
				initialScene={readLibrarySceneSelection(params)}
				browseClipsHref={`${path}/edits`}
				clipEditingAvailable
			/>
		);
	return (
		<LibraryClient browseLocation={libraryLocation} clipEditingAvailable />
	);
}
