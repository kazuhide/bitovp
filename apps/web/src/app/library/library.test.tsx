import {
	type ContentDetail,
	type LibrarySourceView,
	normalizeSceneAnalysis,
} from "@bitovp/core";
import type { QueryObserverOptions } from "@tanstack/react-query";
import { act, fireEvent, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { en } from "@/lib/i18n/messages/en";
import { renderLocalized, renderWithQuery } from "@/test/render";

const apiFetch = vi.fn();
const playback = vi.fn((_props: unknown) => <div>Player</div>);
let canMutate = true;
vi.mock("@/lib/api", async (original) => ({
	...(await original<object>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("@/lib/auth/use-role-access", () => ({
	useMutationAccess: () => canMutate,
}));
vi.mock("@/app/vod/jobs/[id]/playback-surface", () => ({
	PlaybackSurface: (props: unknown) => playback(props),
}));

import { ContentDetailClient } from "./[id]/content-detail";
import { AnalysisView } from "./analysis-view";
import { JobAnalysisPanel, useJobAnalysis } from "./job-analysis-panel";
import { SourcePanel } from "./source-panel";
import { SourceSnapshot } from "./source-snapshot";

beforeEach(() => {
	apiFetch.mockReset();
	playback.mockClear();
	canMutate = true;
});

const sourceDocument = normalizeSceneAnalysis({
	metadata: { version: "1" },
	duration: 10,
	scenes: [
		{
			id: "00000000-0000-4000-8000-000000000001",
			title: "Opening",
			startInSeconds: 2,
			endInSeconds: 5,
		},
	],
});
const playableSource: LibrarySourceView = {
	id: "source",
	jobId: "job",
	originalJobId: "job",
	state: "READY",
	error: null,
	locales: ["en", "ja"],
	contents: [],
	analyses: [
		{
			id: "analysis",
			locale: "en",
			document: sourceDocument,
			createdAt: "2026-09-15",
		},
	],
	snapshot: {
		schemaVersion: 1,
		kind: "VOD_JOB",
		name: "Source",
		planHash: "hash",
		identity: "UNVERIFIED",
		inputs: [],
		qcVerdict: null,
		qcOverriddenAt: null,
		playbackLinks: [
			{
				key: "hls",
				kind: "HLS",
				label: "HLS",
				url: "https://example.test/master.m3u8",
				path: "master.m3u8",
				via: "snapshot",
			},
		],
	},
};

it("explains private outputs instead of losing the playback reason", () => {
	const source: LibrarySourceView = {
		...playableSource,
		snapshot: {
			...playableSource.snapshot,
			playbackLinks: [
				{
					key: "hls",
					kind: "HLS",
					label: "HLS",
					path: "master.m3u8",
					url: null,
					via: "none",
					reason: { code: "NOT_PUBLIC" },
				},
			],
		},
	};
	renderWithQuery(<SourcePanel source={source} />);
	expect(screen.getByText(en.playback.reasonNotPublic)).toBeInTheDocument();
	expect(screen.queryByText(en.library.noPlayback)).not.toBeInTheDocument();
	expect(playback).not.toHaveBeenCalled();
});

it("keeps a private-origin MP4 alternative playable through the library", () => {
	const source: LibrarySourceView = {
		...playableSource,
		snapshot: {
			...playableSource.snapshot,
			playbackLinks: [
				{
					key: "hls",
					kind: "HLS",
					label: "HLS",
					path: "master.m3u8",
					url: null,
					via: "none",
					reason: { code: "NOT_PUBLIC" },
				},
				{
					key: "mp4:video",
					kind: "MP4",
					label: "MP4",
					path: "video.mp4",
					url: "/api/library/sources/00000000-0000-4000-8000-000000000001/media?key=mp4%3Avideo",
					via: "library",
				},
			],
		},
	};
	renderWithQuery(<SourcePanel source={source} />);
	expect(
		screen.queryByText(en.playback.reasonNotPublic),
	).not.toBeInTheDocument();
	expect(playback.mock.calls[0]?.[0]).toMatchObject({
		kind: "MP4",
		url: source.snapshot.playbackLinks[1]?.url,
	});
});

it("embeds analysis in the job without a second player and forwards locale and seeks", () => {
	const onSeek = vi.fn();
	const onLocaleChange = vi.fn();
	const view = renderWithQuery(
		<SourcePanel
			source={playableSource}
			embeddedPlayback={{ locale: "en", onSeek, onLocaleChange }}
		/>,
	);
	expect(playback).not.toHaveBeenCalled();
	expect(
		screen.queryByRole("heading", { name: "AI Scene Analysis" }),
	).not.toBeInTheDocument();
	expect(
		screen.queryByRole("link", { name: "Open source job" }),
	).not.toBeInTheDocument();
	fireEvent.click(
		screen.getByRole("button", { name: "Seek to 2s", hidden: true }),
	);
	expect(onSeek).toHaveBeenCalledWith(2);
	fireEvent.change(screen.getByRole("combobox"), { target: { value: "ja" } });
	expect(onLocaleChange).toHaveBeenCalledWith("ja");
	view.rerender(
		<SourcePanel
			source={playableSource}
			embeddedPlayback={{ locale: "en", onLocaleChange }}
		/>,
	);
	expect(
		screen.getByRole("button", { name: "Seek to 2s", hidden: true }),
	).toBeDisabled();
	view.rerender(
		<SourcePanel
			source={playableSource}
			embeddedPlayback={{ locale: "ja", onLocaleChange }}
		/>,
	);
	expect(
		screen.getByText("No analysis is available for this language."),
	).toBeInTheDocument();
});

it("decorates the standalone library player with the selected analysis", () => {
	renderWithQuery(<SourcePanel source={playableSource} />);
	expect(playback).toHaveBeenCalledWith(
		expect.objectContaining({ sceneAnalysis: sourceDocument }),
	);
	fireEvent.change(screen.getByLabelText("Analysis language"), {
		target: { value: "ja" },
	});
	expect(playback).toHaveBeenLastCalledWith(
		expect.objectContaining({ sceneAnalysis: undefined }),
	);
});

it("omits QC and input snapshots from both analysis presentations", () => {
	const view = renderWithQuery(<SourcePanel source={playableSource} />);
	expect(screen.queryByText("QC / source snapshot (read-only)")).toBeNull();
	view.rerender(
		<SourcePanel
			source={playableSource}
			embeddedPlayback={{ locale: "en", onLocaleChange: () => {} }}
		/>,
	);
	expect(screen.queryByText("QC / source snapshot (read-only)")).toBeNull();
});

it("synchronizes the library inspector to its only player's clock and clears gaps", () => {
	renderWithQuery(<SourcePanel source={playableSource} />);
	const clock = (
		playback.mock.lastCall?.[0] as {
			onTimeChange: (time: number | null) => void;
		}
	).onTimeChange;
	act(() => clock(2));
	expect(screen.getByText("2.00–5.00s · Opening")).toBeVisible();
	expect(screen.getAllByText("Player")).toHaveLength(1);
	act(() => clock(5));
	expect(screen.queryByText("2.00–5.00s · Opening")).toBeNull();
	expect(
		screen.getByText("No scene at the current playback position."),
	).toBeVisible();
});

it("keeps non-AISA content playback without misleading analysis status or missing locale", () => {
	const { container } = renderWithQuery(
		<SourcePanel source={{ ...playableSource, locales: [], analyses: [] }} />,
	);
	expect(
		screen.getByRole("heading", { name: "Playback manifest" }),
	).toBeInTheDocument();
	expect(screen.queryByRole("status")).not.toBeInTheDocument();
	expect(
		screen.queryByText("No analysis is available for this language."),
	).not.toBeInTheDocument();
	expect(container.querySelectorAll("select")).toHaveLength(1);
	expect(playback).toHaveBeenCalled();
});

it.each([
	{ name: "default OSS", player: undefined },
	{ name: "configured OSS", player: { provider: "native" } },
	{
		name: "configured Bitmovin",
		player: { provider: "bitmovin", playerLicenseKey: "configured-key" },
	},
] as const)("uses $name for AISA playback", ({ player }) => {
	renderWithQuery(
		<SourcePanel
			player={player}
			source={{
				id: "source",
				jobId: null,
				originalJobId: "job",
				state: "READY",
				error: null,
				locales: ["en"],
				analyses: [],
				contents: [],
				snapshot: {
					schemaVersion: 1,
					kind: "VOD_JOB",
					name: "Source",
					planHash: "hash",
					identity: "UNVERIFIED",
					inputs: [],
					playbackLinks: [
						{
							key: "hls",
							kind: "HLS",
							label: "HLS",
							url: "https://example.test/master.m3u8",
							path: "master.m3u8",
							via: "snapshot",
						},
					],
					qcVerdict: null,
					qcOverriddenAt: null,
				},
			}}
		/>,
	);
	expect(playback).toHaveBeenCalledWith(
		expect.objectContaining({
			player: player ?? { provider: "native" },
			kind: "HLS",
		}),
	);
});

it("retains the dated QC verdict and bounded evidence after the source job is deleted", () => {
	const { container } = renderLocalized(
		<SourceSnapshot
			source={{
				id: "source",
				jobId: null,
				originalJobId: "deleted-job",
				state: "READY",
				error: null,
				locales: [],
				analyses: [],
				contents: [],
				snapshot: {
					schemaVersion: 1,
					kind: "VOD_JOB",
					name: "Archived source",
					planHash: "hash",
					identity: "UNVERIFIED",
					inputs: [{ name: "input", path: "source.mp4" }],
					playbackLinks: [],
					qcVerdict: { pass: false, ruleResults: [] },
					qcOverriddenAt: "2026-09-14T00:00:00.000Z",
					qcEvidence: [
						{
							id: "qc-report",
							createdAt: "2026-09-13T01:00:00.000Z",
							results: [{ pooled: { mean: 87.25 } }],
						},
					],
				},
			}}
		/>,
	);
	expect(
		screen.getByText("QC / source snapshot (read-only)"),
	).toBeInTheDocument();
	expect(container.querySelector("details")).not.toHaveAttribute("open");
	expect(container).toHaveTextContent("Result: Fail");
	expect(container).toHaveTextContent(
		"20 QC reports and 100 results per report",
	);
	expect(container).toHaveTextContent(
		"not a new measurement or playback verification",
	);
	expect(container).toHaveTextContent("deleted-job");
	expect(container).toHaveTextContent("2026-09-13T01:00:00.000Z");
	expect(container).toHaveTextContent("87.25");
	expect(screen.queryByRole("link")).toBeNull();
});

it("paginates 21 scenes and resets pagination on search", () => {
	const document = normalizeSceneAnalysis({
		metadata: { version: "1" },
		duration: 100,
		scenes: Array.from({ length: 21 }, (_, index) => ({
			id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
			title: `Scene ${index}`,
			startInSeconds: index,
			endInSeconds: index + 1,
		})),
	});
	renderLocalized(<AnalysisView document={document} />);
	expect(screen.getAllByText(/s · Scene \d+$/)).toHaveLength(20);
	fireEvent.click(screen.getByRole("button", { name: "Next" }));
	expect(screen.getAllByText(/s · Scene \d+$/)).toHaveLength(1);
	expect(screen.getByText("20.00–21.00s · Scene 20")).toBeInTheDocument();
	expect(screen.queryByText("0.00–1.00s · Scene 0")).toBeNull();
	fireEvent.change(screen.getByRole("searchbox"), {
		target: { value: "Scene 0" },
	});
	expect(screen.getByText("0.00–1.00s · Scene 0")).toBeInTheDocument();
	expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
});

it("seeks a shot-relative subject at its absolute fractional timestamp", () => {
	const document = normalizeSceneAnalysis({
		metadata: { version: "1" },
		duration: 30,
		scenes: [
			{
				id: "00000000-0000-4000-8000-000000000001",
				startInSeconds: 10,
				endInSeconds: 20,
				shots: [
					{
						startInSeconds: 12.5,
						endInSeconds: 18,
						mainSubjects: [
							{
								classification: "person",
								description: "A visitor",
								appearanceTimeInSeconds: 1.25,
								centerX: 50,
								centerY: 50,
							},
						],
					},
				],
			},
		],
	});
	const onSeek = vi.fn();
	renderLocalized(<AnalysisView document={document} onSeek={onSeek} />);
	fireEvent.click(
		screen.getByRole("button", { name: "Seek to 13.75s", hidden: true }),
	);
	expect(onSeek).toHaveBeenCalledWith(13.75);
});

it("keeps saved metadata read-only without an unavailable editing action", async () => {
	const content: ContentDetail = {
		id: "content",
		title: "Original",
		description: "",
		tags: [],
		locale: "en",
		revision: 2,
		archived: false,
		updatedAt: "2026-09-14",
		source: {
			id: "source",
			jobId: null,
			originalJobId: "job",
			state: "READY",
			error: null,
			locales: ["en"],
			analyses: [],
			contents: [],
			snapshot: {
				schemaVersion: 1,
				kind: "VOD_JOB",
				name: "Source",
				planHash: "hash",
				identity: "UNVERIFIED",
				inputs: [],
				playbackLinks: [],
				qcVerdict: null,
				qcOverriddenAt: null,
			},
		},
	};
	apiFetch.mockResolvedValue(content);
	renderWithQuery(<ContentDetailClient id="content" />);
	expect(
		await screen.findByRole("heading", { name: "Original" }),
	).toBeVisible();
	expect(
		screen.queryByRole("button", { name: "Editing unavailable" }),
	).toBeNull();
	expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();
	expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
	expect(apiFetch.mock.calls.every((call) => !call[1]?.method)).toBe(true);
});

const pinnedContent: ContentDetail = {
	id: "content",
	title: "Saved content",
	description: "",
	tags: [],
	locale: "en",
	revision: 2,
	archived: false,
	updatedAt: "2026-10-05",
	source: playableSource,
};
const sceneSelection = {
	contentRevision: 2,
	analysisRevisionId: "analysis",
	sceneId: "00000000-0000-4000-8000-000000000001",
	locale: "en",
	archived: false,
};

it.each([
	"changed",
	"failed",
])("never auto-seeks cached content before a fresh %s read", async (outcome) => {
	let resolve: (data: ContentDetail) => void = () => {};
	let reject: (error: Error) => void = () => {};
	apiFetch.mockImplementation(
		() =>
			new Promise<ContentDetail>((done, fail) => {
				resolve = done;
				reject = fail;
			}),
	);
	const view = renderWithQuery(null);
	view.client.setQueryDefaults(["library"], { staleTime: Infinity });
	view.client.setQueryData(["library", "content"], pinnedContent);
	view.client.setQueryData(
		["library", "content", sceneSelection],
		pinnedContent,
	);
	view.rerender(
		<ContentDetailClient id="content" initialScene={sceneSelection} />,
	);
	await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledOnce());
	expect(
		playback.mock.calls.some(([props]) =>
			Boolean((props as { seekRequest?: unknown }).seekRequest),
		),
	).toBe(false);
	expect(
		screen.queryByText(
			"This scene link no longer matches the saved content. Select a scene again.",
		),
	).toBeNull();
	if (outcome === "changed") {
		await act(async () => resolve({ ...pinnedContent, revision: 3 }));
		expect(
			await screen.findByText(
				"This scene link no longer matches the saved content. Select a scene again.",
			),
		).toBeVisible();
	} else {
		await act(async () => reject(new Error("Fresh read failed")));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Fresh read failed",
		);
		expect(
			screen.queryByText(
				"This scene link no longer matches the saved content. Select a scene again.",
			),
		).toBeNull();
	}
	expect(
		playback.mock.calls.some(([props]) =>
			Boolean((props as { seekRequest?: unknown }).seekRequest),
		),
	).toBe(false);
});

it("requires a new successful read for a same-pin revisit and a different pin on the same content", async () => {
	apiFetch.mockResolvedValue(pinnedContent);
	const view = renderWithQuery(
		<ContentDetailClient id="content" initialScene={sceneSelection} />,
	);
	await vi.waitFor(() =>
		expect(playback.mock.lastCall?.[0]).toMatchObject({
			seekRequest: { seconds: 2 },
		}),
	);
	view.rerender(null);
	view.client.setQueryDefaults(["library"], { staleTime: Infinity });
	playback.mockClear();
	let resolve: (data: ContentDetail) => void = () => {};
	apiFetch.mockImplementationOnce(
		() =>
			new Promise<ContentDetail>((done) => {
				resolve = done;
			}),
	);
	view.rerender(
		<ContentDetailClient id="content" initialScene={sceneSelection} />,
	);
	await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
	expect(
		playback.mock.calls.some(([props]) =>
			Boolean((props as { seekRequest?: unknown }).seekRequest),
		),
	).toBe(false);
	await act(async () => resolve(pinnedContent));
	await vi.waitFor(() =>
		expect(playback.mock.lastCall?.[0]).toMatchObject({
			seekRequest: { seconds: 2 },
		}),
	);
	const changedPin = { ...sceneSelection, archived: true };
	act(() =>
		view.client.setQueryData(["library", "content", changedPin], {
			...pinnedContent,
			archived: true,
		}),
	);
	apiFetch.mockImplementationOnce(
		() =>
			new Promise<ContentDetail>((done) => {
				resolve = done;
			}),
	);
	playback.mockClear();
	view.rerender(<ContentDetailClient id="content" initialScene={changedPin} />);
	await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
	expect(
		playback.mock.calls.some(([props]) =>
			Boolean((props as { seekRequest?: unknown }).seekRequest),
		),
	).toBe(false);
	expect(
		screen.queryByText(
			"This scene link no longer matches the saved content. Select a scene again.",
		),
	).toBeNull();
	await act(async () => resolve({ ...pinnedContent, archived: true }));
	await vi.waitFor(() =>
		expect(playback.mock.lastCall?.[0]).toMatchObject({
			seekRequest: { seconds: 2 },
		}),
	);
});

it("retries a failed detail read without a mutation", async () => {
	apiFetch
		.mockRejectedValueOnce(new Error("Detail unavailable"))
		.mockResolvedValue(pinnedContent);
	renderWithQuery(<ContentDetailClient id="content" />);
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"Detail unavailable",
	);
	fireEvent.click(screen.getByRole("button", { name: "Retry" }));
	expect(
		await screen.findByRole("heading", { name: "Saved content" }),
	).toBeVisible();
	expect(apiFetch.mock.calls).toEqual([
		["/api/library/content"],
		["/api/library/content"],
	]);
});

it("falls back from an unsupported content locale to available analysis", () => {
	renderWithQuery(<SourcePanel source={playableSource} initialLocale="und" />);
	expect(screen.getByLabelText("Analysis language")).toHaveValue("en");
	expect(
		screen.queryByText("No analysis is available for this language."),
	).toBeNull();
});

it("selects metadata-only scenes without a second player", () => {
	renderWithQuery(
		<SourcePanel
			source={{
				...playableSource,
				snapshot: { ...playableSource.snapshot, playbackLinks: [] },
			}}
		/>,
	);
	fireEvent.click(
		screen.getByRole("button", { name: /Opening · Ad Opportunity/ }),
	);
	expect(screen.getByText("2.00–5.00s · Opening")).toBeVisible();
	expect(playback).not.toHaveBeenCalled();
});

it("applies a validated scene pin once and preserves user navigation across polling", async () => {
	const document = normalizeSceneAnalysis({
		metadata: { version: "1" },
		duration: 20,
		scenes: [
			{
				id: sceneSelection.sceneId,
				title: "Opening",
				startInSeconds: 2,
				endInSeconds: 5,
			},
			{
				id: "00000000-0000-4000-8000-000000000002",
				title: "Later",
				startInSeconds: 10,
				endInSeconds: 15,
			},
		],
	});
	const content = {
		...pinnedContent,
		source: {
			...playableSource,
			analyses: [{ ...playableSource.analyses[0], document }],
		},
	};
	apiFetch.mockResolvedValue(content);
	const view = renderWithQuery(
		<ContentDetailClient id="content" initialScene={sceneSelection} />,
	);
	await screen.findByRole("heading", { name: "Saved content" });
	await vi.waitFor(() =>
		expect(playback.mock.lastCall?.[0]).toMatchObject({
			seekRequest: { seconds: 2, requestId: 1 },
		}),
	);
	fireEvent.click(
		screen.getByRole("button", { name: /Later · Ad Opportunity/ }),
	);
	expect(playback.mock.lastCall?.[0]).toMatchObject({
		seekRequest: { seconds: 10, requestId: 2 },
	});
	act(() =>
		view.client.setQueryData(["library", "content", sceneSelection], {
			...content,
			source: {
				...content.source,
				analyses: content.source.analyses.map((a) => ({ ...a })),
			},
		}),
	);
	expect(playback.mock.lastCall?.[0]).toMatchObject({
		seekRequest: { seconds: 10, requestId: 2 },
	});
	expect(screen.getByText("10.00–15.00s · Later")).toBeVisible();
});

it.each([
	{ contentRevision: 1 },
	{ archived: true },
	{ analysisRevisionId: "foreign-analysis" },
	{ sceneId: "foreign-scene" },
	{ locale: "ja" },
])("refuses stale or foreign scene pins without seeking: %j", async (changed) => {
	apiFetch.mockResolvedValue(pinnedContent);
	renderWithQuery(
		<ContentDetailClient
			id="content"
			initialScene={{ ...sceneSelection, ...changed }}
		/>,
	);
	expect(
		await screen.findByText(
			"This scene link no longer matches the saved content. Select a scene again.",
		),
	).toBeVisible();
	expect(playback.mock.lastCall?.[0]).toMatchObject({ seekRequest: undefined });
});

it("keeps automatic analysis subordinate without a manual import action", () => {
	const view = renderWithQuery(
		<JobAnalysisPanel
			jobId="job"
			enabled
			source={null}
			locale="en"
			onLocaleChange={() => {}}
		/>,
	);
	expect(
		screen.getByText(
			"Analysis is imported automatically after encoding finishes.",
		),
	).toBeInTheDocument();
	expect(screen.queryByRole("button", { name: "Import analysis" })).toBeNull();
	expect(view.container.querySelector("details")).not.toHaveAttribute("open");
	expect(playback).not.toHaveBeenCalled();
});

it.each([
	"en",
	"ja",
] as const)("allows explicit library re-registration after reset (%s)", async (locale) => {
	apiFetch.mockResolvedValue({ sourceId: "source" });
	const view = renderWithQuery(
		<JobAnalysisPanel
			jobId="job"
			enabled
			captureSuppressed
			source={null}
			locale={locale}
			onLocaleChange={() => {}}
		/>,
		locale,
	);
	fireEvent.click(
		screen.getByText(
			locale === "ja" ? "コンテンツライブラリ" : "Content Library",
		),
	);
	const invalidate = vi.spyOn(view.client, "invalidateQueries");
	fireEvent.click(
		screen.getByRole("button", {
			name:
				locale === "ja" ? "ライブラリに再登録" : "Register in library again",
		}),
	);
	await vi.waitFor(() =>
		expect(apiFetch).toHaveBeenCalledWith("/api/encoding-jobs/job/analysis", {
			method: "POST",
		}),
	);
	await vi.waitFor(() =>
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: ["job-analysis", "job"],
		}),
	);
	expect(
		screen.queryByText(
			"Analysis is imported automatically after encoding finishes.",
		),
	).toBeNull();
});

it("does not offer library recapture to a viewer", () => {
	canMutate = false;
	renderWithQuery(
		<JobAnalysisPanel
			jobId="job"
			enabled
			captureSuppressed
			source={null}
			locale="en"
			onLocaleChange={() => {}}
		/>,
	);
	fireEvent.click(screen.getByText("Content Library"));
	expect(
		screen.queryByRole("button", { name: "Register in library again" }),
	).toBeNull();
});

it("does not poll automatically after reset suppressed capture", async () => {
	apiFetch.mockResolvedValue({
		enabled: true,
		captureSuppressed: true,
		source: null,
	});
	function Probe() {
		useJobAnalysis("job", true);
		return null;
	}
	const view = renderWithQuery(<Probe />);
	await vi.waitFor(() =>
		expect(view.client.getQueryData(["job-analysis", "job"])).toEqual({
			enabled: true,
			captureSuppressed: true,
			source: null,
		}),
	);
	const query = view.client
		.getQueryCache()
		.find({ queryKey: ["job-analysis", "job"] });
	if (!query) throw new Error("analysis query missing");
	const interval = (query.options as QueryObserverOptions).refetchInterval;
	expect(typeof interval === "function" && interval(query)).toBe(false);
});

it("warns about excluded provider observations without hiding valid scene data", () => {
	renderLocalized(
		<AnalysisView
			document={{
				...normalizeSceneAnalysis({
					metadata: { version: "1.9.0" },
					duration: 10,
					title: "Kept analysis",
				}),
				omittedSubjectCount: 1,
			}}
		/>,
	);
	expect(screen.getByText("Kept analysis")).toBeInTheDocument();
	expect(screen.getByRole("status")).toHaveTextContent(
		"1 out-of-shot subject observations were omitted",
	);
});

it("offers progressive MP4 in the existing Library playback selector", () => {
	const source = {
		...playableSource,
		snapshot: {
			...playableSource.snapshot,
			playbackLinks: [
				{
					key: "mp4:v360",
					kind: "MP4" as const,
					label: "MP4 360p",
					url: "https://example.test/video.mp4",
					path: "video.mp4",
					via: "derived",
				},
			],
		},
	};
	renderWithQuery(<SourcePanel source={source} />);
	expect(screen.getByRole("option", { name: "MP4 360p" })).toBeInTheDocument();
	expect(playback.mock.calls.at(-1)?.[0]).toMatchObject({
		kind: "MP4",
		url: "https://example.test/video.mp4",
	});
});

it("places content credits and complete provider data in the standalone library overview", () => {
	const raw = {
		metadata: { version: "1.79.0", disclaimer: "Review extraction" },
		duration: 10,
		inputLanguageCodes: ["ja"],
		ratings: [{ rating: "A" }],
		credits: {
			persons: [
				{ name: "Person A", role: "Director", department: "Production" },
			],
			songs: [],
			copyright: "",
		},
	};
	const document = normalizeSceneAnalysis(raw);
	renderWithQuery(
		<SourcePanel
			source={{
				...playableSource,
				analyses: [
					{
						id: "analysis-1",
						locale: "en",
						createdAt: "2026-09-15",
						document,
						providerAnalysis: { source: "PROVIDER", data: raw },
					},
				],
			}}
		/>,
	);
	expect(
		screen.getByRole("region", { name: en.library.contentCredits }),
	).toBeInTheDocument();
	expect(screen.getByText(en.library.analysisAll)).toBeInTheDocument();
	expect(screen.getByText("Review extraction")).toBeInTheDocument();
});
