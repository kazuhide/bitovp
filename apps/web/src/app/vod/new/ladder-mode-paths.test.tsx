import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery as render } from "@/test/render";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
	type WizardState,
} from "./build-plan";
import { MuxingsSection } from "./muxings-section";
import { addVodAudio, addVodVideo } from "./rendition-copy";
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
