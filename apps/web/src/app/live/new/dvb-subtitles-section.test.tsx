import {
	compileLiveChannel,
	liveChannelPlanSchema,
	validateLiveChannel,
} from "@bitovp/core";
import { fireEvent, screen, within } from "@testing-library/react";
import { useState } from "react";
import { expect, it } from "vitest";
import { mergeWizardDraft, projectWizardDraft } from "@/lib/wizard-draft";
import { renderWithQuery } from "@/test/render";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
	type LiveWizardState,
} from "./build-live-plan";
import { LiveDvbSubtitlesSection } from "./dvb-subtitles-section";
import { tryImportLiveChannelIntoWizard } from "./live-plan-to-wizard";

function normal() {
	const s = structuredClone(DEFAULT_LIVE_WIZARD_STATE);
	s.name = "DVB fixture";
	s.inputKind = "SRT";
	s.accountId = "db840363-aed0-44a8-99fe-a6218b904fc1";
	s.start.streamKey = "fixtureLive";
	s.output.credentialId = "0dfc5709-ab1b-4b6c-9936-da5aa9522da2";
	s.output.bucket = "fixture";
	s.output.basePath = "event";
	s.srt.mode = "LISTENER";
	s.manifests.dash.enabled = true;
	return s;
}
it("creates two editable tracks, preserves their destinations and selection through draft and preset restoration", () => {
	const initial = normal();
	function Form() {
		const [state, setState] = useState(initial);
		return (
			<>
				<LiveDvbSubtitlesSection
					state={state}
					onPatch={(p) => setState({ ...state, ...p })}
				/>
				<output data-testid="draft">{JSON.stringify(state)}</output>
			</>
		);
	}
	renderWithQuery(<Form />);
	const add = screen.getByRole("button", { name: "Add DVB subtitle track" });
	fireEvent.click(add);
	fireEvent.change(screen.getByLabelText("Language tag"), {
		target: { value: "ja" },
	});
	fireEvent.change(screen.getByLabelText("Subtitle name"), {
		target: { value: "日本語" },
	});
	fireEvent.click(add);
	const second = within(screen.getByRole("group", { name: "DVB subtitles" }));
	fireEvent.change(second.getByLabelText("Language tag"), {
		target: { value: "en" },
	});
	fireEvent.change(second.getByLabelText("Subtitle name"), {
		target: { value: "English" },
	});
	fireEvent.change(second.getByLabelText("WebVTT delivery"), {
		target: { value: "FMP4" },
	});
	const saved = JSON.parse(
		screen.getByTestId("draft").textContent ?? "",
	) as LiveWizardState;
	const restored = mergeWizardDraft(
		initial,
		projectWizardDraft("live", saved),
		"live",
	);
	const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(restored));
	expect(validateLiveChannel(plan).filter((i) => i.level === "error")).toEqual(
		[],
	);
	expect(plan.dvbSubtitles).toEqual([
		expect.objectContaining({
			language: "ja",
			position: 2,
			packaging: "CHUNKED_TEXT",
			destination: expect.objectContaining({ path: "event/subtitles/dvb-1" }),
		}),
		expect.objectContaining({
			language: "en",
			position: 3,
			packaging: "FMP4",
			destination: expect.objectContaining({ path: "event/subtitles/dvb-2" }),
		}),
	]);
	const opened = tryImportLiveChannelIntoWizard(plan);
	if (!opened.ok) throw Error(opened.reasonKey);
	expect(
		liveChannelPlanSchema.parse(buildLiveChannelPlan(opened.state)),
	).toEqual(plan);
	expect(
		compileLiveChannel(plan).filter(
			(o) => o.kind === "CREATE_DVB_SUBTITLE_INPUT_STREAM",
		),
	).toHaveLength(2);
	fireEvent.click(
		within(screen.getByRole("group", { name: "日本語" })).getByRole("button", {
			name: "Remove subtitle track",
		}),
	);
	expect(screen.getByLabelText("Subtitle name")).toHaveValue("English");
});
it("keeps defaults silent for RTMP and explains an incompatible transport after a change", () => {
	const state = normal();
	state.inputKind = "RTMP";
	const { rerender } = renderWithQuery(
		<LiveDvbSubtitlesSection state={state} onPatch={() => {}} />,
	);
	expect(
		screen.queryByRole("button", { name: "Add DVB subtitle track" }),
	).toBeNull();
	rerender(
		<LiveDvbSubtitlesSection
			state={{
				...state,
				dvbSubtitles: [
					{
						key: "retained",
						label: "日本語",
						language: "ja",
						position: 2,
						packaging: "CHUNKED_TEXT",
					},
				],
			}}
			onPatch={() => {}}
		/>,
	);
	expect(
		screen.getByRole("button", { name: "Add DVB subtitle track" }),
	).toBeDisabled();
	expect(screen.getByText(/Use an SRT/)).toBeVisible();
});
