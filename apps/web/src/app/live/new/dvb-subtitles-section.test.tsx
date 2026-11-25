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
	const publicPlan = liveChannelPlanSchema.parse(
		buildLiveChannelPlan({
			...opened.state,
			output: { ...opened.state.output, publicRead: true },
		}),
	);
	expect(
		publicPlan.dvbSubtitles?.every(
			(track) => track.destination.acl === "PUBLIC_READ",
		),
	).toBe(true);
	const copy = tryImportLiveChannelIntoWizard(publicPlan);
	if (!copy.ok) throw Error(copy.reasonKey);
	const privateCopy = liveChannelPlanSchema.parse(
		buildLiveChannelPlan({
			...copy.state,
			output: { ...copy.state.output, publicRead: false },
		}),
	);
	expect(
		privateCopy.dvbSubtitles?.map((track) => track.destination.acl),
	).toEqual([undefined, undefined]);

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
it.each([
	"event",
	"",
])("moves copied DVB files and keeps a custom relative subtitle folder (%j)", (basePath) => {
	const source = normal();
	source.output.basePath = basePath;
	source.dvbSubtitles = [
		{
			key: "captions",
			position: 2,
			language: "ja",
			label: "Japanese",
			packaging: "CHUNKED_TEXT",
		},
	];
	const original = liveChannelPlanSchema.parse(buildLiveChannelPlan(source));
	const track = original.dvbSubtitles?.[0];
	if (!track) throw new Error("missing subtitle fixture");
	track.destination.path = basePath ? basePath + "/text/ja" : "text/ja";
	const copied = tryImportLiveChannelIntoWizard(original);
	if (!copied.ok) throw new Error(copied.reasonKey);
	const edited = {
		...copied.state,
		output: { ...copied.state.output, basePath: "copy/news" },
	};
	const restored = mergeWizardDraft(
		copied.state,
		projectWizardDraft("live", edited),
		"live",
	);
	const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(restored));
	expect(plan.dvbSubtitles?.[0]?.destination.path).toBe("copy/news/text/ja");
	expect(
		compileLiveChannel(plan).find((op) => op.step === "dvb:captions:muxing")
			?.payload?.outputPath,
	).toBe("copy/news/text/ja");
	expect(track.destination.path).toBe(basePath ? "event/text/ja" : "text/ja");
	if (basePath) {
		track.destination.path = "event-other/text/ja";
		const outside = tryImportLiveChannelIntoWizard(original);
		if (!outside.ok) throw Error(outside.reasonKey);
		expect(
			buildLiveChannelPlan({
				...outside.state,
				output: { ...outside.state.output, basePath: "other-event" },
			}).dvbSubtitles?.[0]?.destination.path,
		).toBe("other-event/subtitles/captions");
	}
});
it.each([
	"PRIVATE",
	undefined,
] as const)("preserves a distinct subtitle ACL (%j) when copying public media", (acl) => {
	const source = normal();
	source.output.publicRead = true;
	source.dvbSubtitles = [
		{
			key: "cc",
			position: 2,
			language: "en",
			label: "English",
			packaging: "CHUNKED_TEXT",
		},
	];
	const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(source));
	const track = plan.dvbSubtitles?.[0];
	if (!track) throw Error("missing caption");
	track.destination.acl = acl;
	const opened = tryImportLiveChannelIntoWizard(plan);
	if (!opened.ok) throw Error(opened.reasonKey);
	const copy = liveChannelPlanSchema.parse(
		buildLiveChannelPlan({
			...opened.state,
			output: { ...opened.state.output, basePath: "second" },
		}),
	);
	expect(copy.dvbSubtitles?.[0]?.destination).toMatchObject({
		path: "second/subtitles/cc",
	});
	expect(copy.dvbSubtitles?.[0]?.destination.acl).toBe(acl);
	expect(copy.muxings[0]?.destination?.acl).toBe("PUBLIC_READ");
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
