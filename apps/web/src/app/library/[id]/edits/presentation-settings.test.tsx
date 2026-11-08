import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import {
	GenerationSettings,
	type GenerationSettingsValue,
} from "./generation-settings";

const initial: GenerationSettingsValue = {
	policy: "COHESION",
	templateId: "portrait-clean",
	variants: 1,
	captions: "AUTO",
	tracking: true,
	language: "auto",
	presentation: {
		version: "portrait-layout-v1",
		videoFit: "FILL",
		captionPlacement: "OVERLAY",
	},
};
const locales = [
	{
		locale: "en" as const,
		video: "Video framing",
		captions: "Caption placement",
		captionMode: "Captions",
		auto: "Auto adjust",
		help: "Video framing — more information",
		autoHelp: "Use saved framing and measured subject tracks.",
		fallbackHelp:
			"Show the full image with a blurred background where neither is available.",
	},
	{
		locale: "ja" as const,
		video: "映像の収め方",
		captions: "字幕の配置",
		captionMode: "字幕",
		auto: "自動で調整",
		help: "「映像の収め方」の説明",
		autoHelp: "設定済みの構図や追跡結果を使います。",
		fallbackHelp: "それ以外は全体表示とぼかし背景で補います。",
	},
];
describe.each(
	locales,
)("explicit DRAFT presentation settings ($locale)", (copy) => {
	it("shows FILL/OVERLAY and changes each choice without altering other settings", () => {
		const changed = vi.fn();
		function Controlled() {
			const [value, setValue] = useState(initial);
			return (
				<GenerationSettings
					value={value}
					disabled={false}
					allowPresentation
					onChange={(next) => {
						changed(next);
						setValue(next);
					}}
				/>
			);
		}
		renderLocalized(<Controlled />, copy.locale);
		expect(screen.getByRole("combobox", { name: copy.video })).toHaveValue(
			"FILL",
		);
		expect(screen.getByRole("combobox", { name: copy.captions })).toHaveValue(
			"OVERLAY",
		);
		fireEvent.change(screen.getByRole("combobox", { name: copy.video }), {
			target: { value: "FIT" },
		});
		expect(changed).toHaveBeenLastCalledWith({
			...initial,
			presentation: { ...initial.presentation, videoFit: "FIT" },
		});
		fireEvent.change(screen.getByRole("combobox", { name: copy.captions }), {
			target: { value: "BANDS" },
		});
		fireEvent.change(screen.getByRole("combobox", { name: copy.captionMode }), {
			target: { value: "OFF" },
		});
		expect(changed).toHaveBeenLastCalledWith({
			...initial,
			captions: "OFF",
			presentation: {
				version: "portrait-layout-v1",
				videoFit: "FIT",
				captionPlacement: "BANDS",
			},
		});
		expect(changed.mock.calls.at(-1)?.[0].presentation).not.toHaveProperty(
			"centerCropConfirmed",
		);
		expect(screen.getByRole("combobox", { name: copy.captions })).toHaveValue(
			"BANDS",
		);
	});
	it("shows explicit AUTO with two short help paragraphs and keeps it when caption placement changes", () => {
		const changed = vi.fn();
		const automatic: GenerationSettingsValue = {
			...initial,
			presentation: {
				version: "portrait-layout-v1",
				videoFit: "AUTO",
				captionPlacement: "OVERLAY",
			},
		};
		function Controlled() {
			const [value, setValue] = useState(automatic);
			return (
				<GenerationSettings
					value={value}
					disabled={false}
					allowPresentation
					onChange={(next) => {
						changed(next);
						setValue(next);
					}}
				/>
			);
		}
		renderLocalized(<Controlled />, copy.locale);
		expect(screen.getByRole("combobox", { name: copy.video })).toHaveValue(
			"AUTO",
		);
		expect(screen.getByRole("option", { name: copy.auto })).toHaveValue("AUTO");
		expect(changed).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: copy.help }));
		expect(screen.getByText(copy.autoHelp)).toBeVisible();
		expect(screen.getByText(copy.fallbackHelp)).toBeVisible();
		expect(changed).not.toHaveBeenCalled();
		fireEvent.change(screen.getByRole("combobox", { name: copy.captions }), {
			target: { value: "BANDS" },
		});
		expect(changed).toHaveBeenLastCalledWith({
			...automatic,
			presentation: { ...automatic.presentation, captionPlacement: "BANDS" },
		});
		fireEvent.change(screen.getByRole("combobox", { name: copy.video }), {
			target: { value: "FILL" },
		});
		expect(changed.mock.calls.at(-1)?.[0].presentation.videoFit).toBe("FILL");
		fireEvent.change(screen.getByRole("combobox", { name: copy.video }), {
			target: { value: "AUTO" },
		});
		expect(changed).toHaveBeenLastCalledWith({
			...automatic,
			presentation: { ...automatic.presentation, captionPlacement: "BANDS" },
		});
	});
	it("keeps an existing missing presentation unchanged until a choice is made", () => {
		const { presentation: _presentation, ...legacy } = initial;
		const changed = vi.fn();
		renderLocalized(
			<GenerationSettings
				value={legacy}
				disabled={false}
				allowPresentation
				onChange={changed}
			/>,
			copy.locale,
		);
		expect(screen.getByRole("combobox", { name: copy.video })).toHaveValue(
			"FILL",
		);
		expect(changed).not.toHaveBeenCalled();
		expect(legacy).not.toHaveProperty("presentation");
	});
	it("preserves the explicit static-candidate policy through framing and caption choices", () => {
		const seeded: GenerationSettingsValue = {
			...initial,
			presentation: {
				version: "portrait-layout-v1",
				videoFit: "FILL",
				captionPlacement: "OVERLAY",
				fallbackFraming: "AISA_STATIC_V1",
			},
		};
		const changed = vi.fn();
		function Controlled() {
			const [value, setValue] = useState(seeded);
			return (
				<GenerationSettings
					value={value}
					disabled={false}
					allowPresentation
					onChange={(next) => {
						changed(next);
						setValue(next);
					}}
				/>
			);
		}
		renderLocalized(<Controlled />, copy.locale);
		expect(
			screen.queryByText(/central crop|中央で切り抜/),
		).not.toBeInTheDocument();
		fireEvent.change(screen.getByRole("combobox", { name: copy.video }), {
			target: { value: "AUTO" },
		});
		expect(changed.mock.calls.at(-1)?.[0].presentation).toEqual({
			...seeded.presentation,
			videoFit: "AUTO",
		});
		fireEvent.change(screen.getByRole("combobox", { name: copy.captions }), {
			target: { value: "BANDS" },
		});
		expect(changed.mock.calls.at(-1)?.[0].presentation).toEqual({
			...seeded.presentation,
			videoFit: "AUTO",
			captionPlacement: "BANDS",
		});
		expect(changed.mock.calls.at(-1)?.[0].presentation).not.toHaveProperty(
			"centerCropConfirmed",
		);
	});
	it("disables both controls with the frozen request settings", () => {
		renderLocalized(
			<GenerationSettings
				value={initial}
				disabled
				allowPresentation
				onChange={vi.fn()}
			/>,
			copy.locale,
		);
		expect(screen.getByRole("combobox", { name: copy.video })).toBeDisabled();
		expect(
			screen.getByRole("combobox", { name: copy.captions }),
		).toBeDisabled();
	});
	it("does not expose DRAFT-only settings to a legacy EXPORT form", () => {
		const { presentation: _presentation, ...legacy } = initial;
		renderLocalized(
			<GenerationSettings value={legacy} disabled={false} onChange={vi.fn()} />,
			copy.locale,
		);
		expect(
			screen.queryByRole("combobox", { name: copy.video }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("combobox", { name: copy.captions }),
		).not.toBeInTheDocument();
	});
});

const protectedCopy = [
	{
		locale: "en" as const,
		video: "Video framing",
		captions: "Caption placement",
		auto: "Full image + blurred background",
		fill: "Crop to fill",
		fit: "Full image + black bars",
		help: "Video framing — more information",
		foreground: "Automatic framing keeps the full source image.",
		background:
			"Unused space uses a blurred background. Choose cropping explicitly to use saved framing.",
	},
	{
		locale: "ja" as const,
		video: "映像の収め方",
		captions: "字幕の配置",
		auto: "全体表示＋ぼかし背景",
		fill: "切り抜いて画面いっぱい",
		fit: "全体表示＋黒帯",
		help: "「映像の収め方」の説明",
		foreground: "自動の構図は切り抜かず、元映像全体を表示します。",
		background:
			"余白をぼかし背景で埋めます。切り抜く場合は画面いっぱいを選びます。",
	},
];
it.each(
	protectedCopy,
)("describes protected AUTO accurately and preserves its policy through explicit choices ($locale)", (copy) => {
	const protectedValue: GenerationSettingsValue = {
		...initial,
		presentation: {
			version: "portrait-layout-v1",
			videoFit: "AUTO",
			fallbackFraming: "PRESERVE_SOURCE_V1",
			captionPlacement: "OVERLAY",
		},
	};
	const changed = vi.fn();
	function Controlled() {
		const [value, setValue] = useState(protectedValue);
		return (
			<GenerationSettings
				value={value}
				disabled={false}
				allowPresentation
				onChange={(next) => {
					changed(next);
					setValue(next);
				}}
			/>
		);
	}
	renderLocalized(<Controlled />, copy.locale);
	expect(screen.getByRole("option", { name: copy.auto })).toHaveValue("AUTO");
	expect(screen.getByRole("option", { name: copy.fill })).toHaveValue("FILL");
	expect(screen.getByRole("option", { name: copy.fit })).toHaveValue("FIT");
	fireEvent.click(screen.getByRole("button", { name: copy.help }));
	expect(screen.getByText(copy.foreground)).toBeVisible();
	expect(screen.getByText(copy.background)).toBeVisible();
	expect(changed).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: copy.help }));
	fireEvent.change(screen.getByRole("combobox", { name: copy.video }), {
		target: { value: "FILL" },
	});
	fireEvent.change(screen.getByRole("combobox", { name: copy.captions }), {
		target: { value: "BANDS" },
	});
	expect(changed).toHaveBeenLastCalledWith({
		...protectedValue,
		presentation: {
			...protectedValue.presentation,
			videoFit: "FILL",
			captionPlacement: "BANDS",
		},
	});
	fireEvent.change(screen.getByRole("combobox", { name: copy.video }), {
		target: { value: "FIT" },
	});
	expect(changed.mock.calls.at(-1)?.[0].presentation).toEqual({
		...protectedValue.presentation,
		videoFit: "FIT",
		captionPlacement: "BANDS",
	});
	expect(changed.mock.calls.at(-1)?.[0].presentation).not.toHaveProperty(
		"centerCropConfirmed",
	);
});
