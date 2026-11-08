import { compileComposition, toCompositionDocument } from "@bitovp/core";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { renderLocalized } from "@/test/render";
import { editingProjectFixture } from "../editing-fixtures";
import {
	buildCompositionTranscriptionRuns,
	CompositionTranscriptionControls,
} from "./composition-transcription-controls";

const mocks = vi.hoisted(() => ({ api: vi.fn(), canMutate: true }));
vi.mock("@/lib/api", async (original) => ({
	...(await original<object>()),
	apiFetch: mocks.api,
}));
vi.mock("@/lib/auth/use-role-access", () => ({
	useMutationAccess: () => mocks.canMutate,
}));
function required<T>(value: T | null | undefined): T {
	if (value === null || value === undefined)
		throw new Error("Missing test fixture");
	return value;
}
const taskId = "77777777-7777-4777-8777-777777777777";
function fixture(origin = 0, editingStartFrame = 0) {
	const project = editingProjectFixture();
	const media = {
		...project.media,
		timeMap: {
			...required(project.media.timeMap),
			sourceStartUs: origin,
			sourceEndUs: origin + 60_000_000,
			editingStartFrame,
			editingEndFrame: editingStartFrame + 1800,
		},
	};
	const document = toCompositionDocument(project.draft);
	const clip = required(document.clips[0]);
	document.clips = [
		{ ...clip, sourceInUs: origin + 10_000_000, durationFrames: 60 },
		{
			...clip,
			id: "88888888-8888-4888-8888-888888888888",
			sourceInUs: origin + 12_000_000,
			durationFrames: 30,
			timelineStartFrame: 60,
		},
		{
			...clip,
			id: "99999999-9999-4999-8999-999999999999",
			sourceInUs: origin + 30_000_000,
			durationFrames: 60,
			timelineStartFrame: 90,
		},
	];
	for (const item of document.clips)
		item.framing = [
			{
				...required(clip.framing[0]),
				fromFrame: 0,
				toFrame: item.durationFrames,
			},
		];
	const plan = compileComposition(document, [
		{
			mediaVersionId: media.id,
			timeMap: media.timeMap,
			width: 1920,
			height: 1080,
			hasAudio: true,
		},
	]);
	return {
		projectId: project.id,
		plan,
		media: [media],
		actorIdentity: "actor:org",
	};
}
function terminal(
	mediaVersionId: string,
	result: unknown = {
		schemaVersion: 1,
		engine: "whisper.cpp",
		sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
		language: "ja",
		segments: [{ startUs: 10_000_000, endUs: 11_000_000, text: "あれ" }],
		warnings: [],
	},
) {
	return {
		taskId,
		kind: "TRANSCRIBE",
		state: "SUCCEEDED",
		mediaVersionId,
		analysisRevisionId: null,
		parentTaskId: null,
		phase: "COMPLETE",
		progress: {},
		result,
		error: null,
		attempts: 1,
		cached: false,
		createdAt: "2026-11-08T10:00:00.000Z",
		finishedAt: "2026-11-08T10:00:01.000Z",
	};
}
beforeEach(() => {
	mocks.api.mockReset();
	mocks.canMutate = true;
});
function open() {
	fireEvent.click(screen.getByText("Check speech recognition"));
}

it("merges only source- and timeline-contiguous audio, and requests prepared offsets with three seconds of context", () => {
	const props = fixture(100_000_000, 90);
	const runs = buildCompositionTranscriptionRuns(props.plan, props.media);
	expect(runs).toHaveLength(2);
	expect(runs[0]).toMatchObject({
		mediaVersionId: required(props.media[0]).id,
		sourceStartUs: 7_000_000,
		durationUs: 9_000_000,
		originalFromUs: 107_000_000,
		originalToUs: 116_000_000,
		outputFromFrame: 0,
		outputToFrame: 90,
	});
	expect(runs[1]).toMatchObject({
		sourceStartUs: 27_000_000,
		durationUs: 8_000_000,
	});
});

it("clamps context at real media boundaries, excludes muted/missing media, and never exceeds the public 180 second limit", () => {
	const props = fixture();
	const first = required(props.plan.audio[0]);
	const plan = {
		...props.plan,
		audio: [
			{
				...first,
				sourceFromFrame: 0,
				automation: { ...first.automation, durationFrames: 30 },
			},
		],
	};
	expect(buildCompositionTranscriptionRuns(plan, props.media)[0]).toMatchObject(
		{ sourceStartUs: 0, durationUs: 4_000_000 },
	);
	expect(
		buildCompositionTranscriptionRuns({ ...plan, audio: [] }, props.media),
	).toEqual([]);
	expect(buildCompositionTranscriptionRuns(plan, [])).toEqual([]);
	expect(
		buildCompositionTranscriptionRuns(plan, [
			{ ...required(props.media[0]), state: "PENDING" },
		]),
	).toEqual([]);
	const longMedia = {
		...required(props.media[0]),
		durationUs: 181_000_000,
		timeMap: {
			...required(required(props.media[0]).timeMap),
			sourceEndUs: 181_000_000,
			editingEndFrame: 5430,
		},
	};
	const longPlan = {
		...plan,
		sources: [{ ...required(plan.sources[0]), timeMap: longMedia.timeMap }],
		audio: [
			{
				...first,
				sourceFromFrame: 0,
				automation: { ...first.automation, durationFrames: 5400 },
			},
		],
	};
	expect(
		buildCompositionTranscriptionRuns(longPlan, [longMedia])[0]?.durationUs,
	).toBe(180_000_000);
	expect(
		buildCompositionTranscriptionRuns(
			{
				...longPlan,
				audio: [
					{
						...required(longPlan.audio[0]),
						automation: { ...first.automation, durationFrames: 5430 },
					},
				],
			},
			[longMedia],
		),
	).toEqual([]);
});

it("is folded, runs no request on open, submits only audio coordinates and shows original-clock results without changing captions", async () => {
	const props = fixture(100_000_000, 90);
	const before = structuredClone(props.plan.document);
	mocks.api
		.mockResolvedValueOnce({ taskId, state: "PENDING", cached: false })
		.mockResolvedValueOnce(
			terminal(required(props.media[0]).id, {
				schemaVersion: 1,
				engine: "whisper.cpp",
				sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
				language: "ja",
				segments: [
					{
						startUs: 110_000_000,
						endUs: 111_000_000,
						text: "あれ",
						words: [
							{
								startUs: 110_000_000,
								endUs: 111_000_000,
								text: "あれ",
								confidence: 0.9,
								startChar: 0,
								endChar: 2,
							},
						],
					},
				],
				warnings: [],
			}),
		);
	renderLocalized(<CompositionTranscriptionControls {...props} />);
	expect(document.querySelector("details")).not.toHaveAttribute("open");
	open();
	expect(mocks.api).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "Recognize this audio" }));
	await screen.findByText("あれ", { selector: "p" });
	const body = JSON.parse(required(mocks.api.mock.calls[0])[1].body);
	expect(body).toEqual({
		kind: "TRANSCRIBE",
		mediaVersionId: required(props.media[0]).id,
		requestKey: expect.any(String),
		parameters: {
			sourceStartUs: 7_000_000,
			durationUs: 9_000_000,
			language: "auto",
		},
	});
	expect(screen.getAllByText(/01:50\.000/).length).toBeGreaterThan(0);
	expect(props.plan.document).toEqual(before);
});

it("retries an unknown POST outcome with exactly the same key/body and locks its settings", async () => {
	const props = fixture();
	mocks.api
		.mockRejectedValueOnce(new TypeError("disconnected"))
		.mockResolvedValueOnce({ taskId, state: "PENDING", cached: false })
		.mockResolvedValueOnce(terminal(required(props.media[0]).id));
	renderLocalized(<CompositionTranscriptionControls {...props} />);
	open();
	fireEvent.click(screen.getByRole("button", { name: "Recognize this audio" }));
	await screen.findByRole("button", { name: "Confirm the same request" });
	expect(screen.getByRole("combobox", { name: "Audio range" })).toBeDisabled();
	fireEvent.click(
		screen.getByRole("button", { name: "Confirm the same request" }),
	);
	await screen.findByText("あれ", { selector: "p" });
	const posts = mocks.api.mock.calls.filter(
		([, options]) => options?.method === "POST",
	);
	expect(posts).toHaveLength(2);
	expect(required(posts[0])[1].body).toBe(required(posts[1])[1].body);
});

it("resumes reading an acknowledged task without creating another task when polling fails", async () => {
	const props = fixture();
	mocks.api
		.mockResolvedValueOnce({ taskId, state: "PENDING", cached: false })
		.mockRejectedValueOnce(new TypeError("offline"))
		.mockResolvedValueOnce(terminal(required(props.media[0]).id));
	renderLocalized(<CompositionTranscriptionControls {...props} />);
	open();
	fireEvent.click(screen.getByRole("button", { name: "Recognize this audio" }));
	fireEvent.click(
		await screen.findByRole("button", { name: "Refresh recognition result" }),
	);
	await screen.findByText("あれ", { selector: "p" });
	expect(
		mocks.api.mock.calls.filter(([, options]) => options?.method === "POST"),
	).toHaveLength(1);
});

it("does not retain a rejected request key and shows a new request after an explicit server rejection", async () => {
	mocks.api.mockRejectedValueOnce(new ApiError(422, "SOURCE_OUT_OF_BOUNDS"));
	renderLocalized(<CompositionTranscriptionControls {...fixture()} />);
	open();
	fireEvent.click(screen.getByRole("button", { name: "Recognize this audio" }));
	await screen.findByRole("alert");
	expect(
		screen.getByRole("combobox", { name: "Audio range" }),
	).not.toBeDisabled();
	expect(
		screen.getByRole("button", { name: "Recognize this audio" }),
	).not.toBeDisabled();
});

it.each([
	"actor:another-org",
	null,
])("aborts and hides old-actor completion after identity changes to %s", async (actorIdentity) => {
	const props = fixture();
	let finish!: (value: unknown) => void;
	mocks.api.mockReturnValueOnce(
		new Promise((resolve) => {
			finish = resolve;
		}),
	);
	const view = renderLocalized(<CompositionTranscriptionControls {...props} />);
	open();
	fireEvent.click(screen.getByRole("button", { name: "Recognize this audio" }));
	const signal = required(mocks.api.mock.calls[0])[1].signal;
	view.rerender(
		<CompositionTranscriptionControls
			{...props}
			actorIdentity={actorIdentity}
		/>,
	);
	expect(signal.aborted).toBe(true);
	finish({ taskId, state: "PENDING", cached: false });
	await waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(1));
	expect(screen.queryByText("あれ")).not.toBeInTheDocument();
});

it("aborts on unmount and never polls an acknowledgement returned after unmount", async () => {
	let finish!: (value: unknown) => void;
	mocks.api.mockReturnValueOnce(
		new Promise((resolve) => {
			finish = resolve;
		}),
	);
	const view = renderLocalized(
		<CompositionTranscriptionControls {...fixture()} />,
	);
	open();
	fireEvent.click(screen.getByRole("button", { name: "Recognize this audio" }));
	const signal = required(mocks.api.mock.calls[0])[1].signal;
	view.unmount();
	expect(signal.aborted).toBe(true);
	finish({ taskId, state: "PENDING", cached: false });
	await waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(1));
});

it("requires edit authorization and an actor even when clicked programmatically", () => {
	mocks.canMutate = false;
	renderLocalized(<CompositionTranscriptionControls {...fixture()} />);
	open();
	fireEvent.click(screen.getByRole("button", { name: "Recognize this audio" }));
	expect(mocks.api).not.toHaveBeenCalled();
	expect(
		screen.getByRole("button", { name: "Recognize this audio" }),
	).toBeDisabled();
});

it.each([
	"media",
	"window",
	"clock",
])("rejects a successful result with mismatched %s evidence", async (mismatch) => {
	const props = fixture();
	const result = terminal(required(props.media[0]).id);
	if (mismatch === "media")
		result.mediaVersionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	if (mismatch === "window")
		result.result = {
			...(result.result as object),
			segments: [{ startUs: 1, endUs: 2, text: "stale" }],
		};
	if (mismatch === "clock")
		result.result = {
			...(result.result as object),
			sourceTimeDomain: "MEDIA_RELATIVE_US",
		};
	mocks.api
		.mockResolvedValueOnce({ taskId, state: "PENDING", cached: false })
		.mockResolvedValueOnce(result);
	renderLocalized(<CompositionTranscriptionControls {...props} />);
	open();
	fireEvent.click(screen.getByRole("button", { name: "Recognize this audio" }));
	if (mismatch === "media")
		await screen.findByRole("button", { name: "Refresh recognition result" });
	else await screen.findByRole("alert");
	expect(screen.queryByText("あれ")).not.toBeInTheDocument();
});

it("shows an empty recognition as no detected speech, not missing captions or an error", async () => {
	const props = fixture();
	mocks.api
		.mockResolvedValueOnce({ taskId, state: "SUCCEEDED", cached: true })
		.mockResolvedValueOnce(
			terminal(required(props.media[0]).id, {
				schemaVersion: 1,
				engine: "whisper.cpp",
				sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
				language: "ja",
				segments: [],
				warnings: [],
			}),
		);
	renderLocalized(<CompositionTranscriptionControls {...props} />, "ja");
	fireEvent.click(screen.getByText("音声認識結果を確認"));
	fireEvent.click(screen.getByRole("button", { name: "この音声を認識" }));
	await screen.findByText("この範囲では発話が検出されませんでした。");
	expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("can recognize an individual clip without surrounding speech or a duplicate click", async () => {
	const props = fixture();
	mocks.api
		.mockResolvedValueOnce({ taskId, state: "PENDING", cached: false })
		.mockResolvedValueOnce(terminal(required(props.media[0]).id));
	renderLocalized(<CompositionTranscriptionControls {...props} />);
	open();
	fireEvent.change(screen.getByRole("combobox", { name: "Audio range" }), {
		target: { value: "2" },
	});
	const button = screen.getByRole("button", { name: "Recognize this audio" });
	fireEvent.click(button);
	fireEvent.click(button);
	await screen.findByText("あれ", { selector: "p" });
	const posts = mocks.api.mock.calls.filter(
		([, options]) => options?.method === "POST",
	);
	expect(posts).toHaveLength(1);
	expect(JSON.parse(required(posts[0])[1].body).parameters).toEqual({
		language: "auto",
		sourceStartUs: 10_000_000,
		durationUs: 2_000_000,
	});
});

it("rounds prepared window edges outwards without adding the nonzero source origin twice", () => {
	const props = fixture(100_000_000, 90);
	const audio = required(props.plan.audio[0]);
	const plan = {
		...props.plan,
		audio: [
			{
				...audio,
				sourceFromFrame: 392,
				automation: { ...audio.automation, durationFrames: 1 },
			},
		],
	};
	expect(
		buildCompositionTranscriptionRuns(plan, props.media, 0, false)[0],
	).toMatchObject({
		sourceStartUs: 10_066_666,
		durationUs: 33_334,
		originalFromUs: 110_066_666,
		originalToUs: 110_100_000,
	});
	const mismatch = [
		{
			...required(props.media[0]),
			timeMap: {
				...required(required(props.media[0]).timeMap),
				id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			},
		},
	];
	expect(buildCompositionTranscriptionRuns(plan, mismatch)).toEqual([]);
});

it("discards an in-flight GET after edit permission is revoked", async () => {
	const props = fixture();
	let finish!: (value: unknown) => void;
	mocks.api
		.mockResolvedValueOnce({ taskId, state: "PENDING", cached: false })
		.mockReturnValueOnce(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
	const view = renderLocalized(<CompositionTranscriptionControls {...props} />);
	open();
	fireEvent.click(screen.getByRole("button", { name: "Recognize this audio" }));
	await waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(2));
	const signal = required(mocks.api.mock.calls[1])[1].signal;
	mocks.canMutate = false;
	view.rerender(<CompositionTranscriptionControls {...props} />);
	expect(signal.aborted).toBe(true);
	finish(terminal(required(props.media[0]).id));
	await waitFor(() =>
		expect(screen.queryByText("あれ")).not.toBeInTheDocument(),
	);
	expect(
		screen.getByRole("button", { name: "Refresh recognition result" }),
	).toBeDisabled();
});

it("does not display an old task result after the selected source range changes", async () => {
	const props = fixture();
	let finish!: (value: unknown) => void;
	mocks.api
		.mockResolvedValueOnce({ taskId, state: "PENDING", cached: false })
		.mockReturnValueOnce(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
	const view = renderLocalized(<CompositionTranscriptionControls {...props} />);
	open();
	fireEvent.click(screen.getByRole("button", { name: "Recognize this audio" }));
	await waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(2));
	const changed = fixture();
	required(changed.plan.audio[0]).sourceFromFrame += 1;
	view.rerender(<CompositionTranscriptionControls {...changed} />);
	expect(required(mocks.api.mock.calls[1])[1].signal.aborted).toBe(true);
	finish(terminal(required(props.media[0]).id));
	await waitFor(() =>
		expect(screen.queryByText("あれ")).not.toBeInTheDocument(),
	);
});

it("keeps the same uncertain request through a temporary workbench disable", async () => {
	const props = fixture();
	let finish!: (value: unknown) => void;
	mocks.api
		.mockReturnValueOnce(
			new Promise((resolve) => {
				finish = resolve;
			}),
		)
		.mockResolvedValueOnce({ taskId, state: "PENDING", cached: false })
		.mockResolvedValueOnce(terminal(required(props.media[0]).id));
	const view = renderLocalized(<CompositionTranscriptionControls {...props} />);
	open();
	fireEvent.click(screen.getByRole("button", { name: "Recognize this audio" }));
	const originalBody = required(mocks.api.mock.calls[0])[1].body;
	view.rerender(<CompositionTranscriptionControls {...props} disabled />);
	finish({ taskId, state: "PENDING", cached: false });
	view.rerender(<CompositionTranscriptionControls {...props} />);
	fireEvent.click(
		await screen.findByRole("button", { name: "Confirm the same request" }),
	);
	await screen.findByText("あれ", { selector: "p" });
	expect(required(mocks.api.mock.calls[1])[1].body).toBe(originalBody);
});

it.each([
	401, 403, 408, 404, 429, 500, 503,
])("retains an accepted task after GET HTTP %i and retries GET only", async (status) => {
	const props = fixture();
	mocks.api
		.mockResolvedValueOnce({ taskId, state: "PENDING", cached: false })
		.mockRejectedValueOnce(new ApiError(status, "TEMPORARY_GET_FAILURE"))
		.mockResolvedValueOnce(terminal(required(props.media[0]).id));
	renderLocalized(<CompositionTranscriptionControls {...props} />);
	open();
	fireEvent.click(screen.getByRole("button", { name: "Recognize this audio" }));
	fireEvent.click(
		await screen.findByRole("button", { name: "Refresh recognition result" }),
	);
	await screen.findByText("あれ", { selector: "p" });
	expect(
		mocks.api.mock.calls.map(([url, options]) => [
			url,
			options?.method ?? "GET",
		]),
	).toEqual([
		["/api/library/media-tasks", "POST"],
		[`/api/library/media-tasks/${taskId}`, "GET"],
		[`/api/library/media-tasks/${taskId}`, "GET"],
	]);
});

it.each([
	"schema",
	"id",
	"kind",
	"media",
])("does not accept an invalid %s GET response or discard its acknowledged task", async (mismatch) => {
	const props = fixture();
	const bad = terminal(required(props.media[0]).id);
	if (mismatch === "id") bad.taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	if (mismatch === "kind") bad.kind = "GENERATE";
	if (mismatch === "media")
		bad.mediaVersionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	mocks.api
		.mockResolvedValueOnce({ taskId, state: "PENDING", cached: false })
		.mockResolvedValueOnce(mismatch === "schema" ? null : bad)
		.mockResolvedValueOnce(terminal(required(props.media[0]).id));
	renderLocalized(<CompositionTranscriptionControls {...props} />);
	open();
	fireEvent.click(screen.getByRole("button", { name: "Recognize this audio" }));
	const refresh = await screen.findByRole("button", {
		name: "Refresh recognition result",
	});
	expect(screen.queryByText("あれ")).not.toBeInTheDocument();
	expect(screen.getByRole("combobox", { name: "Audio range" })).toBeDisabled();
	fireEvent.click(refresh);
	await screen.findByText("あれ", { selector: "p" });
	expect(
		mocks.api.mock.calls.filter(([, options]) => options?.method === "POST"),
	).toHaveLength(1);
	expect(mocks.api.mock.calls.slice(1).map(([url]) => url)).toEqual([
		`/api/library/media-tasks/${taskId}`,
		`/api/library/media-tasks/${taskId}`,
	]);
});

it.each([
	"ERROR",
	"CANCELED",
])("allows a genuinely new request only after the matching task confirms terminal %s", async (state) => {
	const props = fixture();
	const secondId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	const stopped = {
		...terminal(required(props.media[0]).id),
		state,
		result: null,
		error: "ASR_FAILED",
	};
	mocks.api
		.mockResolvedValueOnce({ taskId, state: "PENDING", cached: false })
		.mockResolvedValueOnce(stopped)
		.mockResolvedValueOnce({
			taskId: secondId,
			state: "PENDING",
			cached: false,
		})
		.mockResolvedValueOnce({
			...terminal(required(props.media[0]).id),
			taskId: secondId,
		});
	renderLocalized(<CompositionTranscriptionControls {...props} />);
	open();
	fireEvent.click(screen.getByRole("button", { name: "Recognize this audio" }));
	await screen.findByRole("alert");
	expect(
		screen.getByRole("combobox", { name: "Audio range" }),
	).not.toBeDisabled();
	fireEvent.click(screen.getByRole("button", { name: "Recognize this audio" }));
	await screen.findByText("あれ", { selector: "p" });
	const posts = mocks.api.mock.calls.filter(
		([, options]) => options?.method === "POST",
	);
	expect(posts).toHaveLength(2);
	expect(JSON.parse(required(posts[0])[1].body).requestKey).not.toBe(
		JSON.parse(required(posts[1])[1].body).requestKey,
	);
	expect(
		mocks.api.mock.calls
			.filter(([, options]) => !options?.method)
			.map(([url]) => url),
	).toEqual([
		`/api/library/media-tasks/${taskId}`,
		`/api/library/media-tasks/${secondId}`,
	]);
});
