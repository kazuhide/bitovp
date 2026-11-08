import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import {
	GenerationSettings,
	type GenerationSettingsValue,
} from "./generation-settings";

const settings: GenerationSettingsValue = {
	policy: "COHESION",
	query: "rain",
	templateId: "portrait-clean",
	variants: 1,
	captions: "AUTO",
	tracking: true,
	language: "auto",
};
const locales = [
	{
		locale: "en" as const,
		label: "Selection policy",
		name: "Selection policy — more information",
		cohesion: "Scene continuity",
		duration: "Closest whole-shot duration",
		query: "Context to include",
		speech: /speech boundaries/i,
		details: "Selection policy details",
		common: "Shared rules",
	},
	{
		locale: "ja" as const,
		label: "選択方法",
		name: "「選択方法」の説明",
		cohesion: "シーンのつながりを優先",
		duration: "ショット単位で希望尺に近づける",
		query: "含めたい内容",
		speech: /発話の切れ目/,
		details: "選択方法の詳しい説明",
		common: "共通の条件",
	},
];

describe.each(locales)("selection policy help ($locale)", (copy) => {
	it("describes both actual methods on hover without changing selection", async () => {
		const onChange = vi.fn();
		renderLocalized(
			<GenerationSettings
				value={settings}
				disabled={false}
				onChange={onChange}
			/>,
			copy.locale,
		);
		const trigger = screen.getByRole("button", { name: copy.name });
		expect(trigger).toHaveAttribute("aria-expanded", "false");
		const details = screen.getByText(copy.details).closest("details");
		expect(details).not.toHaveAttribute("open");
		if (!details) throw Error("Missing policy details");
		expect(
			within(details).getByRole("heading", {
				name: copy.cohesion,
				hidden: true,
			}),
		).toBeInTheDocument();
		expect(
			within(details).getByRole("heading", {
				name: copy.duration,
				hidden: true,
			}),
		).toBeInTheDocument();
		expect(
			within(details).getByRole("heading", { name: copy.common, hidden: true }),
		).toBeInTheDocument();
		expect(details).toHaveTextContent(/80%/);
		expect(details).toHaveTextContent(copy.speech);
		await userEvent.hover(trigger);
		const note = screen.getByRole("note");
		expect(note).toBeVisible();
		expect(note).toHaveTextContent(copy.cohesion);
		expect(note).toHaveTextContent(copy.duration);
		expect(note).not.toHaveTextContent(/80%/);
		expect(note).not.toHaveTextContent(copy.speech);
		await userEvent.unhover(trigger);
		await waitFor(() =>
			expect(screen.queryByRole("note")).not.toBeInTheDocument(),
		);
		expect(screen.getByRole("combobox", { name: copy.label })).toHaveValue(
			"COHESION",
		);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("is available on keyboard focus and Escape preserves that focus", async () => {
		renderLocalized(
			<GenerationSettings
				value={settings}
				disabled={false}
				onChange={vi.fn()}
			/>,
			copy.locale,
		);
		const trigger = screen.getByRole("button", { name: copy.name });
		await userEvent.tab();
		expect(trigger).toHaveFocus();
		expect(screen.getByRole("note")).toBeVisible();
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("note")).not.toBeInTheDocument();
		expect(trigger).toHaveFocus();
	});

	it("can be opened by a touch-style click even while settings are disabled", () => {
		const onChange = vi.fn();
		renderLocalized(
			<GenerationSettings value={settings} disabled onChange={onChange} />,
			copy.locale,
		);
		const trigger = screen.getByRole("button", { name: copy.name });
		fireEvent.click(trigger);
		expect(screen.getByRole("note")).toBeVisible();
		expect(screen.getByRole("combobox", { name: copy.label })).toBeDisabled();
		expect(trigger).not.toBeDisabled();
		fireEvent.click(trigger);
		expect(screen.queryByRole("note")).not.toBeInTheDocument();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("keeps option values and the query-disable contract when the method changes", async () => {
		const onChange = vi.fn();
		function Controlled() {
			const [value, setValue] = useState(settings);
			return (
				<GenerationSettings
					value={value}
					disabled={false}
					onChange={(next) => {
						onChange(next);
						setValue(next);
					}}
				/>
			);
		}
		renderLocalized(<Controlled />, copy.locale);
		const select = screen.getByRole("combobox", { name: copy.label });
		expect(screen.getByRole("option", { name: copy.cohesion })).toHaveValue(
			"COHESION",
		);
		expect(screen.getByRole("option", { name: copy.duration })).toHaveValue(
			"DURATION",
		);
		await userEvent.selectOptions(select, "DURATION");
		expect(onChange).toHaveBeenLastCalledWith({
			...settings,
			policy: "DURATION",
		});
		expect(screen.getByRole("textbox", { name: copy.query })).toBeDisabled();
		expect(screen.getByRole("textbox", { name: copy.query })).toHaveValue(
			"rain",
		);
		expect(screen.getByText(copy.details).closest("details")).toHaveTextContent(
			/80%/,
		);
	});
});

it.each(
	locales,
)("offers no-hint automatic selection only for a reviewable draft ($locale)", async (c) => {
	const onChange = vi.fn();
	function Controlled() {
		const [value, setValue] = useState(settings);
		return (
			<GenerationSettings
				value={value}
				disabled={false}
				allowPresentation
				onChange={(next) => {
					setValue(next);
					onChange(next);
				}}
			/>
		);
	}
	renderLocalized(<Controlled />, c.locale);
	const select = screen.getByRole("combobox", { name: c.label });
	expect(
		screen.getByRole("option", {
			name: c.locale === "ja" ? "見どころを自動選定" : "Automatic highlights",
		}),
	).toHaveValue("AUTO");
	await userEvent.selectOptions(select, "AUTO");
	expect(select).toHaveValue("AUTO");
	expect(
		screen.queryByRole("textbox", { name: c.query }),
	).not.toBeInTheDocument();
	expect(onChange).toHaveBeenLastCalledWith({
		...settings,
		policy: "AUTO",
		query: undefined,
	});
	await userEvent.selectOptions(select, "COHESION");
	expect(screen.getByRole("textbox", { name: c.query })).toBeEnabled();
	expect(screen.getByRole("textbox", { name: c.query })).toHaveValue("");
});
it.each(
	locales,
)("retains the legacy direct-export methods without automatic selection ($locale)", (c) => {
	renderLocalized(
		<GenerationSettings value={settings} disabled={false} onChange={vi.fn()} />,
		c.locale,
	);
	expect(
		screen.queryByRole("option", {
			name: c.locale === "ja" ? "見どころを自動選定" : "Automatic highlights",
		}),
	).not.toBeInTheDocument();
});
