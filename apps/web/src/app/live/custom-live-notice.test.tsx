import {
	type LiveChannelPlan,
	liveChannelPlanSchema,
	resolveLiveEncodingOption,
	validateLiveChannel,
} from "@bitovp/core";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { messagesFor, translate } from "@/lib/i18n";
import { renderLocalized, renderWithQuery } from "@/test/render";
import { ChannelLifecycleActions } from "./[id]/channel-actions";
import { CustomLiveNotice } from "./custom-live-notice";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
} from "./new/build-live-plan";
import { LivePlanPreview } from "./new/live-plan-preview";

function compatiblePlan(): LiveChannelPlan {
	return liveChannelPlanSchema.parse(
		buildLiveChannelPlan({
			...DEFAULT_LIVE_WIZARD_STATE,
			name: "HD notice test",
			accountId: "00000000-0000-4000-8000-000000000001",
			inputKind: "RTMP",
			output: {
				...DEFAULT_LIVE_WIZARD_STATE.output,
				credentialId: "00000000-0000-4000-8000-000000000002",
				bucket: "test-output",
				basePath: "test/hd-notice",
			},
			start: {
				...DEFAULT_LIVE_WIZARD_STATE.start,
				streamKey: "syntheticTestKey",
			},
		}),
	);
}

function firstVideo(plan: LiveChannelPlan) {
	const video = plan.renditions.find((r) => r.codec === "H264");
	if (video?.codec !== "H264") throw new Error("H264 fixture missing");
	return video;
}

describe.each([
	"en",
	"ja",
] as const)("Custom Live notice (%s), real policy and catalogue", (locale) => {
	const messages = messagesFor(locale);
	const title = messages.liveWizard.customLiveNotice;
	it("keeps the Custom decision visible while legacy detail opens only on request", () => {
		const plan = compatiblePlan();
		delete plan.start.encodingOption;
		renderLocalized(<CustomLiveNotice plan={plan} compact />, locale);
		expect(screen.getByRole("note", { name: title })).toBeVisible();
		expect(screen.queryByText(messages.liveWizard.customLegacy)).toBeNull();
		fireEvent.click(screen.getByRole("button"));
		expect(screen.getByText(messages.liveWizard.customLegacy)).toBeVisible();
		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByText(messages.liveWizard.customLegacy)).toBeNull();
	});
	it.each([
		"ZIXI",
		"HLS",
	] as const)("explains unconfirmed HD input %s using the real policy", (kind) => {
		const plan = compatiblePlan();
		plan.liveInput =
			kind === "ZIXI"
				? {
						key: plan.liveInput.key,
						kind,
						name: "Test Zixi",
						host: "example.invalid",
						port: 2088,
						stream: "test",
						credentialId: "00000000-0000-4000-8000-000000000001",
					}
				: {
						key: plan.liveInput.key,
						kind,
						name: "Test HLS",
						url: "https://example.invalid/master.m3u8",
					};
		expect(resolveLiveEncodingOption(plan)).toEqual({
			encodingOption: "CUSTOM",
			reasons: [{ code: "INPUT_PROTOCOL", actual: kind }],
		});
		const view = renderLocalized(<CustomLiveNotice plan={plan} />, locale);
		const note = screen.getByRole("note", { name: title });
		expect(note).toHaveTextContent(kind);
		expect(note).toHaveTextContent(
			locale === "ja"
				? "入力はRTMP・冗長RTMP・SRT"
				: "inputs are RTMP, redundant RTMP and SRT",
		);
		view.rerender(
			<CustomLiveNotice
				plan={{ ...plan, start: { ...plan.start, encodingOption: "HD" } }}
			/>,
		);
		expect(screen.queryByRole("note", { name: title })).toBeNull();
	});

	it("keeps a compatible AUTO plan quiet without a mode picker", () => {
		const plan = compatiblePlan();
		expect(resolveLiveEncodingOption(plan)).toEqual({
			encodingOption: "HD",
			reasons: [],
		});
		const { container } = renderLocalized(
			<CustomLiveNotice plan={plan} />,
			locale,
		);
		expect(container).toBeEmptyDOMElement();
		expect(screen.queryByRole("combobox")).toBeNull();
	});

	it.each([
		60, 61,
	])("explains the Custom selection for %sfps before starting", (rate) => {
		const plan = compatiblePlan();
		firstVideo(plan).rate = rate;
		expect(resolveLiveEncodingOption(plan)).toMatchObject({
			encodingOption: "CUSTOM",
			reasons: [{ code: "VIDEO_FRAME_RATE", actual: rate, limit: 30 }],
		});
		renderLocalized(<CustomLiveNotice plan={plan} />, locale);
		const note = screen.getByRole("note", { name: title });
		expect(note).toHaveTextContent(
			translate(messages, "liveWizard.customFps", { actual: rate, limit: 30 }),
		);
		expect(note).toHaveTextContent(messages.liveWizard.customLiveExplanation);
		expect(within(note).getAllByRole("listitem")).toHaveLength(1);
	});

	it("names HEVC as the reason instead of claiming an HD-compatible source", () => {
		const raw = compatiblePlan();
		const plan = liveChannelPlanSchema.parse({
			...raw,
			renditions: raw.renditions.map((r) => {
				if (r.codec !== "H264") return r;
				const { width: _h264OnlyWidth, ...video } = r;
				return { ...video, codec: "H265" };
			}),
		});
		expect(resolveLiveEncodingOption(plan).encodingOption).toBe("CUSTOM");
		renderLocalized(<CustomLiveNotice plan={plan} />, locale);
		expect(screen.getByRole("note", { name: title })).toHaveTextContent(
			translate(messages, "liveWizard.customCodec", { actual: "H265" }),
		);
	});

	it.each([
		undefined,
		"CUSTOM",
	] as const)("explains retained %s Custom without saying AUTO fell back", (option) => {
		const plan = compatiblePlan();
		if (option === undefined) delete plan.start.encodingOption;
		else plan.start.encodingOption = option;
		renderLocalized(<CustomLiveNotice plan={plan} />, locale);
		const note = screen.getByRole("note", { name: title });
		expect(note).toHaveTextContent(
			option === undefined
				? messages.liveWizard.customLegacy
				: messages.liveWizard.customRequested,
		);
		expect(note).not.toHaveTextContent(
			messages.liveWizard.customLiveExplanation,
		);
	});

	it("blocks incompatible explicit HD without promising a Custom fallback", () => {
		const plan = compatiblePlan();
		plan.start.encodingOption = "HD";
		firstVideo(plan).rate = 60;
		const issues = validateLiveChannel(plan);
		expect(issues).toContainEqual(
			expect.objectContaining({ code: "LIVE_HD_INCOMPATIBLE", level: "error" }),
		);
		renderLocalized(
			<LivePlanPreview evaluation={{ ok: true, plan, issues, ops: [] }} />,
			locale,
		);
		expect(screen.getByText(messages.ui.blocked)).toBeInTheDocument();
		expect(screen.queryByRole("note", { name: title })).toBeNull();
		expect(screen.queryByText(title)).toBeNull();
	});

	it("shows the real Custom reason beside the start action, not during an active run", () => {
		const plan = compatiblePlan();
		firstVideo(plan).rate = 60;
		const props = {
			channelId: "00000000-0000-4000-8000-000000000003",
			hasEncoding: false,
			plan,
		};
		const view = renderWithQuery(
			<ChannelLifecycleActions {...props} status="CREATED" />,
			locale,
		);
		expect(
			screen.getByRole("button", { name: messages.live.start }),
		).toBeInTheDocument();
		expect(screen.getByRole("note", { name: title })).toBeVisible();
		fireEvent.click(
			within(screen.getByRole("note", { name: title })).getByRole("button"),
		);
		expect(screen.getByText(/60fps/)).toBeVisible();
		view.rerender(
			<ChannelLifecycleActions {...props} hasEncoding status="RUNNING" />,
		);
		expect(screen.queryByRole("note", { name: title })).toBeNull();
	});
});
