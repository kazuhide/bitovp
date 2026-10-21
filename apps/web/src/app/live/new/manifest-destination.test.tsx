import { liveChannelPlanSchema, validateLiveChannel } from "@bitovp/core";
import { fireEvent, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
	type LiveWizardState,
} from "./build-live-plan";
import { addLiveManifest } from "./live-output-actions";
import { LiveManifestListSection } from "./manifest-list-section";

function fixture(kind: "HLS" | "DASH") {
	let state = structuredClone(DEFAULT_LIVE_WIZARD_STATE);
	state.name = "Available manifest outputs";
	state.accountId = "00000000-0000-4000-8000-000000000001";
	state.output = {
		...state.output,
		credentialId: "00000000-0000-4000-8000-000000000002",
		bucket: "media",
		basePath: "live/test",
		name: "Primary media",
	};
	state.archive = {
		output: {
			...state.output,
			bucket: "recordings",
			name: "Dedicated recordings",
		},
		muxing: {
			key: "archive",
			kind: "MP4",
			streamKey: "v720",
			additionalStreamKeys: ["a128"],
			filename: "archive.mp4",
			destination: { outputKey: "archive-output", path: "live/test/archive" },
		},
	};
	state = { ...state, ...addLiveManifest(state, kind) };
	return state;
}

function Harness({ initial }: { initial: LiveWizardState }) {
	const [state, setState] = useState(initial);
	return (
		<LiveManifestListSection
			state={state}
			onPatch={(patch) => setState((previous) => ({ ...previous, ...patch }))}
		/>
	);
}

function destination(kind: "HLS" | "DASH") {
	const select = document.getElementById(
		`lw-manifest-${kind.toLowerCase()}-2-destination`,
	);
	if (!(select instanceof HTMLSelectElement))
		throw new Error("Missing manifest destination");
	return select;
}

describe("Live manifest output selection", () => {
	it.each([
		"HLS",
		"DASH",
	] as const)("does not offer archive-only storage for an additional %s master", (kind) => {
		const state = fixture(kind);
		expect(
			validateLiveChannel(
				liveChannelPlanSchema.parse(buildLiveChannelPlan(state)),
			).filter((issue) => issue.level === "error"),
		).toEqual([]);
		renderLocalized(<Harness initial={state} />);
		expect(
			within(destination(kind)).queryByRole("option", {
				name: "Dedicated recordings",
			}),
		).not.toBeInTheDocument();
		expect(
			within(destination(kind)).getByRole("option", { name: "Primary media" }),
		).toBeEnabled();
	});

	it.each([
		"alias",
		"mirror",
		"origin-mirror",
	])("retains an archive output that reaches the media through %s", (mode) => {
		const state = fixture("HLS");
		if (!state.archive?.output) throw new Error("Missing archive fixture");
		if (mode === "alias") state.archive.output.bucket = state.output.bucket;
		else
			state.mirror = {
				...state.output,
				bucket: state.archive.output.bucket,
				name: "Delivery mirror",
			};
		if (mode === "origin-mirror") state.output.kind = "LIVE_MEDIA_INGEST";
		renderLocalized(<Harness initial={state} />);
		expect(
			within(destination("HLS")).getByRole("option", {
				name: "Dedicated recordings",
			}),
		).toBeEnabled();
	});

	it("keeps an imported unavailable selection visible until the operator fixes it", () => {
		const state = fixture("HLS");
		const manifest = state.manifests.additionalHls?.[0];
		if (!manifest?.destination) throw new Error("Missing manifest fixture");
		manifest.destination.outputKey = "archive-output";
		renderLocalized(<Harness initial={state} />, "ja");
		const select = destination("HLS");
		expect(select).toHaveValue("archive-output");
		expect(
			within(select).getByRole("option", { selected: true }),
		).toBeDisabled();
		fireEvent.change(select, { target: { value: "origin" } });
		expect(select).toHaveValue("origin");
		expect(
			within(select).queryByRole("option", { selected: true }),
		).toBeEnabled();
	});
});
