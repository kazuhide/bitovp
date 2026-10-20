import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery as render } from "@/test/render";
import {
	buildPlan,
	DEFAULT_WIZARD_QC,
	DEFAULT_WIZARD_STATE,
	type WizardState,
} from "./build-plan";
import { MuxingsSection } from "./muxings-section";
import {
	addVodAudio,
	addVodVideo,
	updateVodVideoHeight,
	updateVodVideoModePaths,
} from "./rendition-copy";
import { LadderSection } from "./wizard-sections";

vi.mock("@/lib/api", async (original) => ({
	...(await original<object>()),
	apiFetch: async () => [],
}));

function Harness({ initial }: { initial: WizardState }) {
	const [state, setState] = useState(initial);
	const onPatch = (patch: Partial<WizardState>) =>
		setState((current) => ({ ...current, ...patch }));
	return (
		<>
			<LadderSection state={state} credentials={[]} onPatch={onPatch} />
			<MuxingsSection state={state} credentials={[]} onPatch={onPatch} />
			<output data-testid="path-state">{JSON.stringify(state)}</output>
			<output data-testid="path-plan">
				{JSON.stringify(buildPlan(state))}
			</output>
		</>
	);
}

function currentState(): WizardState {
	return JSON.parse(screen.getByTestId("path-state").textContent ?? "{}");
}

function destinationPaths(): Array<string | undefined> {
	const plan = JSON.parse(screen.getByTestId("path-plan").textContent ?? "{}");
	return plan.muxings.map(
		(muxing: { destination?: { path: string } }) => muxing.destination?.path,
	);
}

function copiedState(): WizardState {
	const initial = structuredClone(DEFAULT_WIZARD_STATE);
	return { ...initial, ...addVodVideo(initial, 0) };
}

function emittedPaths(state: WizardState): string[] {
	const paths: string[] = [];
	const visit = (value: unknown) => {
		if (Array.isArray(value)) {
			value.forEach(visit);
		} else if (value && typeof value === "object") {
			for (const [key, child] of Object.entries(value)) {
				if (
					key === "destination" &&
					child &&
					typeof child === "object" &&
					"path" in child &&
					typeof child.path === "string"
				) {
					paths.push(child.path);
				} else {
					visit(child);
				}
			}
		}
	};
	visit(buildPlan(state));
	return paths;
}

const outputNamespaces: Array<{
	name: string;
	claim: (path: string) => Partial<WizardState>;
}> = [
	{
		name: "standalone audio",
		claim: (path) => ({
			audios: [{ bitrate: 64_000, rate: 44_100, muxing: { path } }],
		}),
	},
	{
		name: "extra audio container",
		claim: (path) => ({
			audios: [
				{
					bitrate: 64_000,
					rate: 44_100,
					extraMuxings: [{ key: "audio-extra", path }],
				},
			],
		}),
	},
	{
		name: "audio without a video carrier despite ownContainer being false",
		claim: (path) => ({
			audios: [
				{
					bitrate: 64_000,
					rate: 44_100,
					muxing: { path, ownContainer: false },
				},
			],
		}),
	},
	{
		name: "encrypted primary audio",
		claim: (path) => ({
			audios: [{ bitrate: 64_000, rate: 44_100 }],
			drm: [
				{
					kind: "CENC",
					muxingKey: "a64",
					credentialId: "vault",
					kid: "kid",
					path,
				},
			],
		}),
	},
	{
		name: "encrypted extra audio container",
		claim: (path) => ({
			audios: [
				{
					bitrate: 64_000,
					rate: 44_100,
					extraMuxings: [{ key: "audio-protected" }],
				},
			],
			drm: [
				{
					kind: "CENC",
					muxingKey: "audio-protected",
					credentialId: "vault",
					kid: "kid",
					path,
				},
			],
		}),
	},
	...(["WEBVTT", "IMSC"] as const).map((codec) => ({
		name: `${codec} subtitles`,
		claim: (path: string): Partial<WizardState> => ({
			subtitles: [{ codec, source: "captions", muxing: { path } }],
		}),
	})),
	{
		name: "thumbnail",
		claim: (path) => ({
			thumbnails: [
				{ key: "thumb", streamKey: "v360", height: 90, positions: [0], path },
			],
		}),
	},
	{
		name: "sprite",
		claim: (path) => ({
			sprites: [
				{
					key: "sprite",
					streamKey: "v360",
					distance: 5,
					width: 160,
					filename: "sprite.jpg",
					path,
				},
			],
		}),
	},
	{
		name: "AI scene analysis",
		claim: (path) => ({
			startOptions: { aiSceneAnalysis: { filename: "analysis.json", path } },
		}),
	},
];

describe("automatic container paths follow the ladder stream mode", () => {
	it("updates paths pinned by Add video to Per-Title destinations in both the form and emitted plan", () => {
		render(<Harness initial={copiedState()} />);
		expect(document.getElementById("wz-mx-v-0-path")).toHaveValue("video/360p");
		fireEvent.click(screen.getByRole("radio", { name: "Per-Title" }));
		expect(document.getElementById("wz-mx-v-0-path")).toHaveValue(
			"video/v360/{height}p_{bitrate}_{uuid}",
		);
		expect(document.getElementById("wz-mx-v-1-path")).toHaveValue(
			"video/v360-2/{height}p_{bitrate}_{uuid}",
		);
		expect(destinationPaths().slice(0, 2)).toEqual([
			"video/v360/{height}p_{bitrate}_{uuid}",
			"video/v360-2/{height}p_{bitrate}_{uuid}",
		]);
		expect(screen.getByTestId("path-plan")).not.toHaveTextContent("autoPath");
	});

	it("also updates the video path pinned when an audio rendition is added", () => {
		const initial = structuredClone(DEFAULT_WIZARD_STATE);
		render(<Harness initial={{ ...initial, ...addVodAudio(initial, 0) }} />);
		fireEvent.change(screen.getByLabelText("Stream mode"), {
			target: { value: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION" },
		});
		expect(destinationPaths()[0]).toBe("video/v360/{height}p_{bitrate}_{uuid}");
	});

	it("removes generated Per-Title markers without merging the isolated copy directories when returning to Standard", () => {
		render(<Harness initial={copiedState()} />);
		fireEvent.click(screen.getByRole("radio", { name: "Per-Title" }));
		fireEvent.click(screen.getByRole("radio", { name: "Standard" }));
		expect(destinationPaths().slice(0, 2)).toEqual([
			"video/v360",
			"video/v360-2",
		]);
		fireEvent.click(screen.getByRole("radio", { name: "Per-Title" }));
		expect(destinationPaths().slice(0, 2)).toEqual([
			"video/v360/{height}p_{bitrate}_{uuid}",
			"video/v360-2/{height}p_{bitrate}_{uuid}",
		]);
	});

	it("keeps a sibling's manually claimed directory when an automatic rendition returns to Standard", () => {
		render(<Harness initial={copiedState()} />);
		const originalMode = screen.getAllByLabelText("Stream mode")[0] as Element;
		fireEvent.change(originalMode, {
			target: { value: "PER_TITLE_TEMPLATE" },
		});
		fireEvent.change(document.getElementById("wz-mx-v-1-path") as Element, {
			target: { value: "video/v360" },
		});
		fireEvent.change(originalMode, { target: { value: "STANDARD" } });
		fireEvent.change(document.getElementById("wz-v-0-bitrate") as Element, {
			target: { value: "300000" },
		});
		const [automatic, manual] = destinationPaths();
		expect(manual).toBe("video/v360");
		expect(automatic).not.toBe(manual);
		expect(automatic).toBe(currentState().videos[0]?.muxing?.autoPath);
		expect(currentState().videos[0]?.bitrate).toBe(300_000);
		expect(currentState().videos[1]?.muxing?.autoPath).toBeUndefined();
		fireEvent.change(originalMode, {
			target: { value: "PER_TITLE_TEMPLATE" },
		});
		fireEvent.change(originalMode, { target: { value: "STANDARD" } });
		expect(destinationPaths().slice(0, 2)).toEqual([automatic, manual]);
	});

	it("keeps a manually claimed standalone audio directory when returning to Standard", () => {
		render(<Harness initial={copiedState()} />);
		const originalMode = screen.getAllByLabelText("Stream mode")[0] as Element;
		fireEvent.change(originalMode, { target: { value: "PER_TITLE_TEMPLATE" } });
		fireEvent.change(document.getElementById("wz-mx-a-0-path") as Element, {
			target: { value: "video/v360" },
		});
		fireEvent.change(originalMode, { target: { value: "STANDARD" } });
		fireEvent.change(document.getElementById("wz-v-0-bitrate") as Element, {
			target: { value: "300000" },
		});
		expect(currentState().audios[0]?.muxing?.path).toBe("video/v360");
		expect(destinationPaths()[0]).not.toBe("video/v360");
		expect(
			emittedPaths(currentState()).filter((path) => path === "video/v360"),
		).toHaveLength(1);
	});

	it("reserves an audio directory that is the allocator's next candidate", () => {
		render(<Harness initial={copiedState()} />);
		const originalMode = screen.getAllByLabelText("Stream mode")[0] as Element;
		fireEvent.change(originalMode, { target: { value: "PER_TITLE_TEMPLATE" } });
		fireEvent.change(document.getElementById("wz-mx-v-1-path") as Element, {
			target: { value: "video/v360" },
		});
		fireEvent.change(document.getElementById("wz-mx-a-0-path") as Element, {
			target: { value: "video/v360-2" },
		});
		fireEvent.change(originalMode, { target: { value: "STANDARD" } });
		fireEvent.change(document.getElementById("wz-v-0-bitrate") as Element, {
			target: { value: "300000" },
		});
		expect(destinationPaths().slice(0, 3)).toEqual([
			"video/v360-3",
			"video/v360",
			"video/v360-2",
		]);
	});

	describe.each([
		"entering",
		"leaving",
	] as const)("%s Per-Title", (direction) => {
		it.each(outputNamespaces)("reserves the $name output namespace", ({
			claim,
		}) => {
			const initial = copiedState();
			if (direction === "leaving") {
				const current = initial.videos[0];
				if (!current) throw new Error("Missing original video");
				initial.videos[0] = {
					...current,
					extras: { ...current.extras, mode: "PER_TITLE_TEMPLATE" },
					muxing: {
						...current.muxing,
						path: "video/v360/{height}p_{bitrate}_{uuid}",
						autoPath: "video/v360/{height}p_{bitrate}_{uuid}",
					},
				};
			}
			const state = { ...initial, ...claim("video/v360") };
			const untouched = structuredClone(state);
			const videos = state.videos.map((video, index) =>
				index === 0
					? {
							...video,
							extras: {
								...video.extras,
								mode:
									direction === "entering"
										? ("PER_TITLE_TEMPLATE" as const)
										: ("STANDARD" as const),
							},
						}
					: video,
			);
			const updated = { ...state, ...updateVodVideoModePaths(state, videos) };
			const path = updated.videos[0]?.muxing?.path;
			expect(path?.split("/").slice(0, 2).join("/")).not.toBe("video/v360");
			expect(
				emittedPaths(updated).filter((value) => value === "video/v360"),
			).toHaveLength(1);
			expect(state).toEqual(untouched);
			for (const [key, value] of Object.entries(claim("video/v360"))) {
				expect(updated[key as keyof WizardState]).toEqual(value);
			}
		});
	});

	it("rechecks an already allocated copy root when entering Per-Title", () => {
		const initial = copiedState();
		initial.audios[0] = {
			bitrate: 64_000,
			rate: 44_100,
			muxing: { path: "video/v360-2" },
		};
		render(<Harness initial={initial} />);
		fireEvent.change(screen.getAllByLabelText("Stream mode")[1] as Element, {
			target: { value: "PER_TITLE_TEMPLATE" },
		});
		expect(destinationPaths().slice(0, 3)).toEqual([
			"video/360p",
			"video/v360-2-2/{height}p_{bitrate}_{uuid}",
			"video/v360-2",
		]);
	});

	it("does not reserve primary or extra audio containers carried only inside a video container", () => {
		const initial = copiedState();
		const current = initial.videos[0];
		if (!current) throw new Error("Missing original video");
		initial.videos[0] = {
			...current,
			muxing: { ...current.muxing, kind: "TS", muxedAudioKeys: ["a64"] },
		};
		initial.audios = [
			{
				bitrate: 64_000,
				rate: 44_100,
				muxing: { ownContainer: false, path: "video/v360" },
				extraMuxings: [
					{ key: "bundled-extra", ownContainer: false, path: "video/v360-2" },
				],
			},
		];
		const videos = initial.videos.map((video, index) =>
			index === 0
				? {
						...video,
						extras: { ...video.extras, mode: "PER_TITLE_TEMPLATE" as const },
					}
				: video,
		);
		const updated = { ...initial, ...updateVodVideoModePaths(initial, videos) };
		expect(updated.videos[0]?.muxing?.path).toBe(
			"video/v360/{height}p_{bitrate}_{uuid}",
		);
		expect(
			buildPlan(updated).muxings.some((muxing) => muxing.streamKey === "a64"),
		).toBe(false);
		expect(updated.audios).toEqual(initial.audios);
	});

	it("does not reserve delivery outputs omitted from a quality-only plan", () => {
		const initial = copiedState();
		for (const { claim } of outputNamespaces)
			Object.assign(initial, claim("video/v360"));
		initial.drm = [];
		initial.qc = { ...DEFAULT_WIZARD_QC, vmaf: true, only: true };
		const videos = initial.videos.map((video, index) =>
			index === 0
				? {
						...video,
						extras: { ...video.extras, mode: "PER_TITLE_TEMPLATE" as const },
					}
				: video,
		);
		const updated = { ...initial, ...updateVodVideoModePaths(initial, videos) };
		expect(updated.videos[0]?.muxing?.path).toBe(
			"video/v360/{height}p_{bitrate}_{uuid}",
		);
		expect(emittedPaths(updated)).not.toContain("video/v360");
	});

	describe.each([
		"copy",
		"height",
	] as const)("allocating a video %s", (operation) => {
		it.each(outputNamespaces)("reserves the $name output namespace", ({
			claim,
		}) => {
			const path = operation === "copy" ? "video/v360-2" : "video/v480";
			const state = {
				...structuredClone(DEFAULT_WIZARD_STATE),
				...claim(path),
			};
			const untouched = structuredClone(state);
			const patch =
				operation === "copy"
					? addVodVideo(state, 0)
					: updateVodVideoHeight(state, 0, 480);
			const updated = { ...state, ...patch };
			const video = updated.videos[operation === "copy" ? 1 : 0];
			expect(video?.muxing?.path).not.toBe(path);
			expect(
				emittedPaths(updated).filter((value) => value === path),
			).toHaveLength(1);
			expect(state).toEqual(untouched);
		});

		it("does not reserve a bundled audio destination that is not emitted", () => {
			const path = operation === "copy" ? "video/v360-2" : "video/v480";
			const state = structuredClone(DEFAULT_WIZARD_STATE);
			state.videos[0] = {
				...state.videos[0],
				height: 360,
				bitrate: 300_000,
				muxing: { kind: "TS", muxedAudioKeys: ["a64"] },
			};
			state.audios[0] = {
				bitrate: 64_000,
				rate: 44_100,
				muxing: { ownContainer: false, path },
			};
			const patch =
				operation === "copy"
					? addVodVideo(state, 0)
					: updateVodVideoHeight(state, 0, 480);
			const updated = { ...state, ...patch };
			expect(updated.videos[operation === "copy" ? 1 : 0]?.muxing?.path).toBe(
				path,
			);
			expect(
				buildPlan(updated).muxings.some((muxing) => muxing.streamKey === "a64"),
			).toBe(false);
		});
	});

	it("keeps a manually claimed DRM directory when an automatic encrypted rendition returns to Standard", () => {
		const initial = structuredClone(DEFAULT_WIZARD_STATE);
		initial.drm = [
			{ kind: "CENC", muxingKey: "v360", credentialId: "vault", kid: "kid" },
		];
		render(<Harness initial={{ ...initial, ...addVodVideo(initial, 0) }} />);
		const originalMode = screen.getAllByLabelText("Stream mode")[0] as Element;
		fireEvent.change(originalMode, {
			target: { value: "PER_TITLE_TEMPLATE" },
		});
		fireEvent.change(
			document.getElementById("wz-mx-v-1-drm-1-path") as Element,
			{
				target: { value: "video/v360" },
			},
		);
		fireEvent.change(originalMode, { target: { value: "STANDARD" } });
		const [automatic, manual] = currentState().drm ?? [];
		expect(manual?.path).toBe("video/v360");
		expect(automatic?.path).toBeDefined();
		expect(automatic?.path).not.toBe(manual?.path);
		expect(automatic?.path).toBe(automatic?.autoPath);
		const plan = JSON.parse(
			screen.getByTestId("path-plan").textContent ?? "{}",
		);
		expect(
			plan.drm.map(
				(row: { destination: { path: string } }) => row.destination.path,
			),
		).toEqual([automatic?.path, manual?.path]);
		expect(destinationPaths().slice(0, 2)).toEqual([undefined, undefined]);
	});

	it("keeps a manual extra-container directory on the same rendition when returning to Standard", () => {
		const initial = copiedState();
		const original = initial.videos[0];
		if (!original) throw new Error("Missing original video");
		original.extraMuxings = [
			{ key: "alternate", kind: "FMP4", path: "archive/manual" },
		];
		render(<Harness initial={initial} />);
		const originalMode = screen.getAllByLabelText("Stream mode")[0] as Element;
		fireEvent.change(originalMode, {
			target: { value: "PER_TITLE_TEMPLATE" },
		});
		fireEvent.change(document.getElementById("wz-mx-v-0-x0-path") as Element, {
			target: { value: "video/v360" },
		});
		fireEvent.change(originalMode, { target: { value: "STANDARD" } });
		const [automatic, manual] = destinationPaths();
		expect(manual).toBe("video/v360");
		expect(automatic).not.toBe(manual);
		expect(currentState().videos[0]?.extraMuxings?.[0]).toMatchObject({
			key: "alternate",
			path: "video/v360",
		});
	});

	it("keeps an explicit path even when its text equals the old derived default", () => {
		const initial = structuredClone(DEFAULT_WIZARD_STATE);
		initial.videos[0] = {
			height: 360,
			bitrate: 300_000,
			muxing: { path: "video/360p" },
		};
		render(<Harness initial={initial} />);
		fireEvent.click(screen.getByRole("radio", { name: "Per-Title" }));
		expect(destinationPaths()[0]).toBe("video/360p");
	});

	it("keeps a manually edited copy path while updating the untouched original", () => {
		render(<Harness initial={copiedState()} />);
		fireEvent.change(document.getElementById("wz-mx-v-1-path") as Element, {
			target: { value: "archive/manual" },
		});
		fireEvent.click(screen.getByRole("radio", { name: "Per-Title" }));
		expect(destinationPaths().slice(0, 2)).toEqual([
			"video/v360/{height}p_{bitrate}_{uuid}",
			"archive/manual",
		]);
	});

	it("releases path ownership when a manual edit returns to the original generated text", () => {
		render(<Harness initial={copiedState()} />);
		const path = document.getElementById("wz-mx-v-1-path") as Element;
		fireEvent.change(path, { target: { value: "archive/manual" } });
		fireEvent.change(path, { target: { value: "video/v360-2" } });
		fireEvent.click(screen.getByRole("radio", { name: "Per-Title" }));
		expect(currentState().videos[1]?.muxing?.autoPath).toBeUndefined();
		expect(destinationPaths()[1]).toBe("video/v360-2");
	});

	it("avoids a directory already used by a custom sibling output", () => {
		const initial = copiedState();
		initial.videos.push({
			height: 480,
			bitrate: 800_000,
			extras: { key: "archive" },
			muxing: { path: "video/v360" },
		});
		render(<Harness initial={initial} />);
		fireEvent.click(screen.getByRole("radio", { name: "Per-Title" }));
		expect(destinationPaths().slice(0, 3)).toEqual([
			"video/v360-3/{height}p_{bitrate}_{uuid}",
			"video/v360-2/{height}p_{bitrate}_{uuid}",
			"video/v360",
		]);
	});

	it("keeps the isolated directory of an automatically copied extra container", () => {
		const initial = structuredClone(DEFAULT_WIZARD_STATE);
		const original = initial.videos[0];
		if (!original) throw new Error("Missing video");
		original.extraMuxings = [{ key: "transport", kind: "TS" }];
		const copied = { ...initial, ...addVodVideo(initial, 0) };
		render(<Harness initial={copied} />);
		fireEvent.change(screen.getAllByLabelText("Stream mode")[1] as Element, {
			target: { value: "PER_TITLE_TEMPLATE" },
		});
		expect(currentState().videos[0]).toEqual(copied.videos[0]);
		expect(currentState().videos[1]?.extraMuxings?.[0]?.path).toBe(
			"video/v360-2/ts-2/{height}p_{bitrate}_{uuid}",
		);
	});

	it("updates derived DRM destinations without enabling an unintended clear output", () => {
		const initial = structuredClone(DEFAULT_WIZARD_STATE);
		initial.drm = [
			{
				kind: "CENC",
				muxingKey: "v360",
				credentialId: "vault",
				kid: "kid",
			},
		];
		const copied = { ...initial, ...addVodVideo(initial, 0) };
		render(<Harness initial={copied} />);
		fireEvent.click(screen.getByRole("radio", { name: "Per-Title" }));
		expect(currentState().drm?.map((row) => row.path)).toEqual([
			"video/v360/{height}p_{bitrate}_{uuid}",
			"video/v360-2/cenc/{height}p_{bitrate}_{uuid}",
		]);
		expect(destinationPaths().slice(0, 2)).toEqual([undefined, undefined]);
	});

	it.each([
		"CENC",
		"SPEKE",
	] as const)("keeps a manually restored %s destination under manual control", (kind) => {
		const initial = structuredClone(DEFAULT_WIZARD_STATE);
		initial.drm = [
			kind === "CENC"
				? { kind, muxingKey: "v360", credentialId: "vault", kid: "kid" }
				: { kind, muxingKey: "v360", credentialId: "vault", systemIds: [] },
		];
		const copied = { ...initial, ...addVodVideo(initial, 0) };
		render(<Harness initial={copied} />);
		const path = document.getElementById("wz-mx-v-1-drm-1-path");
		if (!path) throw new Error("Missing copied DRM path");
		const generated = `video/v360-2/${kind.toLowerCase()}`;
		fireEvent.change(path, { target: { value: "protected/manual" } });
		fireEvent.change(path, { target: { value: generated } });
		fireEvent.click(screen.getByRole("radio", { name: "Per-Title" }));
		expect(currentState().drm?.[1]?.autoPath).toBeUndefined();
		expect(currentState().drm?.[1]?.path).toBe(generated);
	});

	it("changes only the selected rendition and retains custom extra-container and DRM sibling destinations", () => {
		const initial = copiedState();
		const copy = initial.videos[1];
		if (!copy) throw new Error("Missing copied video");
		copy.extraMuxings = [
			{
				key: "archive",
				kind: "MP4",
				filename: "archive.mp4",
				path: "archive/manual",
			},
		];
		initial.drm = [
			{
				kind: "CENC",
				muxingKey: "v360",
				credentialId: "vault",
				kid: "kid",
				path: "protected/original",
			},
			{
				kind: "CENC",
				muxingKey: "archive",
				credentialId: "vault",
				kid: "kid",
				path: "protected/archive",
			},
		];
		render(<Harness initial={initial} />);
		const modes = screen.getAllByLabelText("Stream mode");
		fireEvent.change(modes[1] as Element, {
			target: { value: "PER_TITLE_TEMPLATE" },
		});
		const state = currentState();
		expect(state.videos[0]?.muxing).toEqual(initial.videos[0]?.muxing);
		expect(state.videos[1]?.muxing?.path).toBe(
			"video/v360-2/{height}p_{bitrate}_{uuid}",
		);
		expect(state.videos[1]?.extraMuxings).toEqual(copy.extraMuxings);
		expect(state.drm).toEqual(initial.drm);
	});
});
