import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VOD_FLOW_COOKIE } from "@/lib/vod-flow";
import { persistVodFlow } from "@/lib/vod-flow-preference";
import { renderLocalized } from "@/test/render";
import { VodFlowPreference } from "./vod-flow-preference";

function remember(value: string | null) {
	// biome-ignore lint/suspicious/noDocumentCookie: jsdom has no CookieStore
	document.cookie =
		value === null
			? `${VOD_FLOW_COOKIE}=; Path=/; Max-Age=0`
			: `${VOD_FLOW_COOKIE}=${value}; Path=/`;
}

beforeEach(() => remember(null));

describe("VodFlowPreference — the default flow, from Settings", () => {
	it.each([
		[null, "streaming"],
		["file", "file"],
		["streaming", "streaming"],
		// A value no flow has is the same as no value.
		["mezzanine", "streaming"],
	] as const)("shows what this browser remembers (%j → %s)", (cookie, flow) => {
		remember(cookie);
		renderLocalized(<VodFlowPreference />);
		expect(
			screen.getByRole("combobox", { name: "New VOD job flow" }),
		).toHaveValue(flow);
	});

	it("names both flows as the wizard does", () => {
		renderLocalized(<VodFlowPreference />, "ja");
		expect(
			screen.getAllByRole("option").map((option) => option.textContent),
		).toEqual(["配信用にパッケージする", "ファイルを書き出す"]);
	});

	it("remembers a change for the whole site, for two years", async () => {
		const written = vi.spyOn(document, "cookie", "set");
		renderLocalized(<VodFlowPreference />);
		const select = screen.getByRole("combobox", { name: "New VOD job flow" });
		await userEvent.selectOptions(select, "file");
		expect(select).toHaveValue("file");
		expect(written).toHaveBeenLastCalledWith(
			`${VOD_FLOW_COOKIE}=file; Path=/; Max-Age=63072000; SameSite=Lax`,
		);
		expect(document.cookie).toContain(`${VOD_FLOW_COOKIE}=file`);

		await userEvent.selectOptions(select, "streaming");
		expect(select).toHaveValue("streaming");
		expect(document.cookie).toContain(`${VOD_FLOW_COOKIE}=streaming`);
		written.mockRestore();
	});

	it("follows a choice made on the New VOD job page", () => {
		renderLocalized(<VodFlowPreference />);
		const select = screen.getByRole("combobox", { name: "New VOD job flow" });
		expect(select).toHaveValue("streaming");
		act(() => persistVodFlow("file"));
		expect(select).toHaveValue("file");
	});
});
