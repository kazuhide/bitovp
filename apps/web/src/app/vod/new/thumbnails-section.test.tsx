import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import { DEFAULT_WIZARD_STATE } from "./build-plan";
import { ThumbnailsSection } from "./thumbnails-section";

function Harness() {
	const [state, setState] = useState({
		...DEFAULT_WIZARD_STATE,
		thumbnails: [
			{ key: "thumb1", streamKey: "v1", height: 360, positions: [0] },
		],
	});
	return (
		<>
			<ThumbnailsSection
				state={state}
				onPatch={(patch) => setState((s) => ({ ...s, ...patch }))}
			/>
			<output data-testid="positions">
				{JSON.stringify(state.thumbnails[0]?.positions)}
			</output>
		</>
	);
}

describe("thumbnail position editing", () => {
	it("retains separators and fractional input while updating numeric plan positions", async () => {
		const user = userEvent.setup();
		renderLocalized(<Harness />);
		const input = screen.getByPlaceholderText("0, 10, 30");
		await user.type(input, ",");
		expect(input).toHaveValue("0,");
		await user.type(input, " 10.5, 30");
		expect(input).toHaveValue("0, 10.5, 30");
		expect(screen.getByTestId("positions")).toHaveTextContent("[0,10.5,30]");
		await user.tab();
		expect(input).toHaveValue("0, 10.5, 30");
	});

	it("normalizes a trailing comma on blur and allows clearing and re-entry", async () => {
		const user = userEvent.setup();
		renderLocalized(<Harness />);
		const input = screen.getByPlaceholderText("0, 10, 30");
		await user.clear(input);
		expect(screen.getByTestId("positions")).toHaveTextContent("[]");
		await user.type(input, "2.5, 8,");
		expect(input).toHaveValue("2.5, 8,");
		await user.tab();
		expect(input).toHaveValue("2.5, 8");
		expect(screen.getByTestId("positions")).toHaveTextContent("[2.5,8]");
	});
});
