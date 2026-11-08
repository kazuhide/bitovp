import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { Field } from "@/components/ui/field";
import { renderLocalized } from "@/test/render";
import { GenerationSettings } from "./[id]/edits/generation-settings";
import { EditingDetails, EditingHelpText } from "./editing-help";

it("opens structured field help without editing its control and returns focus on Escape", async () => {
	const changed = vi.fn();
	renderLocalized(
		<Field
			label="字幕"
			htmlFor="caption"
			help={
				<EditingHelpText>
					<p>字幕の配置を選びます。</p>
					<p>背景を調整できます。</p>
				</EditingHelpText>
			}
		>
			<input id="caption" value="元の字幕" onChange={changed} />
		</Field>,
		"ja",
	);
	const trigger = screen.getByRole("button", { name: "「字幕」の説明" });
	await userEvent.click(trigger);
	expect(screen.getByRole("note")).toBeVisible();
	expect(screen.getByText("字幕の配置を選びます。")).toBeVisible();
	expect(screen.getByText("背景を調整できます。")).toBeVisible();
	expect(screen.getByRole("textbox", { name: "字幕" })).toHaveValue("元の字幕");
	expect(changed).not.toHaveBeenCalled();
	await userEvent.keyboard("{Escape}");
	expect(screen.queryByRole("note")).not.toBeInTheDocument();
	expect(trigger).toHaveFocus();
});

it("keeps long explanations behind a named native disclosure", () => {
	renderLocalized(
		<EditingDetails summary="選択の条件">
			<h3>共通の条件</h3>
			<p>元映像の順序を保ちます。</p>
		</EditingDetails>,
		"ja",
	);
	expect(screen.getByText("選択の条件").closest("details")).not.toHaveAttribute(
		"open",
	);
	expect(screen.getByText("元映像の順序を保ちます。")).not.toBeVisible();
	expect(
		screen.getByRole("heading", { name: "共通の条件", hidden: true }),
	).toBeInTheDocument();
});

it("does not change the caption language when its help is opened", async () => {
	const changed = vi.fn();
	renderLocalized(
		<GenerationSettings
			value={{
				policy: "COHESION",
				templateId: "portrait-clean",
				variants: 1,
				captions: "AUTO",
				tracking: true,
				language: "auto",
			}}
			disabled={false}
			onChange={changed}
		/>,
		"ja",
	);
	await userEvent.click(screen.getByRole("button", { name: "「字幕」の説明" }));
	expect(screen.getByRole("combobox", { name: "字幕" })).toHaveValue(
		"ORIGINAL",
	);
	expect(changed).not.toHaveBeenCalled();
	expect(screen.getByRole("note")).toHaveTextContent(/単語単位の強調/);
});
