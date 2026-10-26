import { liveChannelPlanSchema, validateLiveChannel } from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { audioKeys, videoKeys } from "@/app/vod/new/build-plan";
import { renderLocalized } from "@/test/render";
import { LiveArchiveSection } from "./archive-section";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
	type LiveWizardState,
} from "./build-live-plan";
import { LiveLadderSection } from "./ladder-section";
import { tryImportLiveChannelIntoWizard } from "./live-plan-to-wizard";

function required<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("Missing test fixture");
	return value;
}

function Harness({ initial }: { initial: LiveWizardState }) {
	const [state, setState] = useState(initial);
	const patch = (partial: Partial<LiveWizardState>) =>
		setState((prev) => ({ ...prev, ...partial }));
	return (
		<>
			<LiveLadderSection state={state} onPatch={patch} />
			<LiveArchiveSection state={state} onPatch={patch} credentials={[]} />
			<output data-testid="state">{JSON.stringify(state)}</output>
		</>
	);
}
function current(): LiveWizardState {
	return JSON.parse(screen.getByTestId("state").textContent ?? "{}");
}
function fixture(): LiveWizardState {
	const state = structuredClone(DEFAULT_LIVE_WIZARD_STATE);
	state.name = "stable-key-channel";
	state.accountId = "33333333-3333-4333-8333-333333333333";
	state.output = {
		...state.output,
		credentialId: "44444444-4444-4444-8444-444444444444",
		bucket: "media",
		basePath: "stable",
	};
	state.manifests.dash.enabled = false;
	state.videos = [
		{ ...required(state.videos[0]), container: "TS", muxedAudioKeys: ["a128"] },
	];
	state.audios = [{ codec: "AAC", bitrate: 128000, rate: 48000 }];
	state.archive = {
		muxing: {
			key: "archive",
			kind: "MP4",
			streamKey: required(videoKeys(state.videos)[0]),
			additionalStreamKeys: ["a128"],
			filename: "archive.mp4",
			destination: { outputKey: "origin", path: "archive" },
		},
	};
	return state;
}
describe("Live ladder reference identity", () => {
	it("keeps bundled audio and archive selections through bitrate and height edits", () => {
		const initial = fixture();
		renderLocalized(<Harness initial={initial} />);
		fireEvent.change(required(document.getElementById("lw-a-0-bitrate")), {
			target: { value: "192000" },
		});
		fireEvent.change(required(document.getElementById("lw-v-0-height")), {
			target: { value: "540" },
		});
		expect(audioKeys(current().audios)).toEqual(["a128"]);
		expect(videoKeys(current().videos)).toEqual(videoKeys(initial.videos));
		expect(current().videos[0]?.muxedAudioKeys).toEqual(["a128"]);
		expect(document.getElementById("lw-archive-video")).toHaveValue(
			required(initial.archive).muxing.streamKey,
		);
	});
	it("adds multiple default rows without key collisions or rebinding existing selections", () => {
		const initial = fixture();
		renderLocalized(<Harness initial={initial} />);
		for (let i = 0; i < 3; i++) {
			fireEvent.click(screen.getByRole("button", { name: /Add audio/ }));
			fireEvent.click(screen.getByRole("button", { name: /Add video/ }));
		}
		const state = current();
		expect(new Set(audioKeys(state.audios)).size).toBe(4);
		expect(new Set(videoKeys(state.videos)).size).toBe(4);
		const plan = buildLiveChannelPlan(state);
		const paths = plan.muxings
			.filter((m) => m.kind !== "MP4")
			.map((m) => required(m.destination).path);
		expect(new Set(paths).size).toBe(paths.length);
		expect(
			validateLiveChannel(liveChannelPlanSchema.parse(plan)).filter(
				(issue) => issue.level === "error",
			),
		).toEqual([]);
		expect(audioKeys(state.audios)[0]).toBe("a128");
		expect(videoKeys(state.videos)[0]).toBe(
			required(initial.archive).muxing.streamKey,
		);
	});
	it("deleting a sibling keeps remaining stream keys and leaves removed archive references visibly unavailable", () => {
		const initial = fixture();
		initial.videos.push({ ...required(initial.videos[0]), bitrate: 1500000 });
		initial.audios.push({ codec: "AAC", bitrate: 128000, rate: 44100 });
		const originalVideoKeys = videoKeys(initial.videos),
			originalAudioKeys = audioKeys(initial.audios);
		required(initial.archive).muxing.streamKey = required(originalVideoKeys[0]);
		required(initial.archive).muxing.additionalStreamKeys = [
			required(originalAudioKeys[0]),
		];
		renderLocalized(<Harness initial={initial} />);
		fireEvent.click(
			screen.getByRole("button", { name: /Remove video rendition 1/i }),
		);
		fireEvent.click(
			screen.getByRole("button", { name: /Remove audio rendition 1/i }),
		);
		expect(videoKeys(current().videos)).toEqual([originalVideoKeys[1]]);
		expect(audioKeys(current().audios)).toEqual([originalAudioKeys[1]]);
		expect(
			screen.getAllByRole("option", { name: /unavailable/i }).length,
		).toBeGreaterThanOrEqual(2);
	});
});

it("round-trips stable imported keys and their existing muxing paths exactly", () => {
	const state = fixture();
	state.name = "stable keys";
	state.accountId = "33333333-3333-4333-8333-333333333333";
	state.output = {
		...state.output,
		credentialId: "44444444-4444-4444-8444-444444444444",
		bucket: "media",
		basePath: "stable",
	};
	delete state.archive;
	required(state.videos[0]).extras = { key: "v9" };
	required(state.audios[0]).extras = { key: "a9" };
	required(state.videos[0]).muxedAudioKeys = ["a9"];
	const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(state));
	const imported = tryImportLiveChannelIntoWizard(plan);
	expect(imported.ok).toBe(true);
	if (!imported.ok) throw new Error("roundtrip refused");
	expect(imported.state.videos[0]?.extras?.key).toBe("v9");
	expect(imported.state.audios[0]?.extras?.key).toBe("a9");
	expect(
		liveChannelPlanSchema.parse(buildLiveChannelPlan(imported.state)),
	).toEqual(plan);
	required(required(plan.muxings[0]).destination).path =
		"custom/preserved/provider-path";
	const custom = tryImportLiveChannelIntoWizard(plan);
	expect(custom.ok).toBe(true);
	if (!custom.ok) throw new Error("Custom path import refused");
	expect(custom.state.videos[0]?.muxing?.path).toBe(
		"custom/preserved/provider-path",
	);
	expect(
		liveChannelPlanSchema.parse(buildLiveChannelPlan(custom.state)),
	).toEqual(plan);
});

it("bundles only the selected audio by default and preserves an explicit standalone override", () => {
	const initial = fixture();
	delete required(initial.videos[0]).muxedAudioKeys;
	initial.audios.push({
		codec: "AAC",
		bitrate: 192000,
		rate: 48000,
		extras: { key: "a192" },
		ownContainer: true,
	});
	renderLocalized(<Harness initial={initial} />);
	const bundled = required(document.getElementById("lw-v-0-muxaudio"));
	fireEvent.change(bundled, { target: { value: "a128" } });
	expect(document.getElementById("lw-a-0-own")).not.toBeChecked();
	expect(document.getElementById("lw-a-1-own")).toBeChecked();
	expect(current().audios[1]).toEqual(initial.audios[1]);
	const plan = buildLiveChannelPlan(current());
	expect(
		plan.muxings.find((m) => m.kind === "TS")?.additionalStreamKeys,
	).toEqual(["a128"]);
	expect(plan.muxings.some((m) => m.streamKey === "a128")).toBe(false);
	expect(plan.muxings.some((m) => m.streamKey === "a192")).toBe(true);
	fireEvent.click(required(document.getElementById("lw-a-0-own")));
	expect(document.getElementById("lw-a-0-own")).toBeChecked();
	expect(
		buildLiveChannelPlan(current()).muxings.some((m) => m.streamKey === "a128"),
	).toBe(true);
	fireEvent.change(bundled, { target: { value: "a192" } });
	expect(document.getElementById("lw-a-1-own")).not.toBeChecked();
	expect(document.getElementById("lw-a-0-own")).toBeChecked();
});
