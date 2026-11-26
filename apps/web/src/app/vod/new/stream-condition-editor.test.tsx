import type { StreamCondition } from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import { StreamConditionEditor } from "./stream-condition-editor";

function Example({ live = false }: { live?: boolean }) {
	const [condition, change] = useState<StreamCondition>();
	return (
		<>
			<StreamConditionEditor
				idBase="track"
				media="video"
				live={live}
				value={condition}
				onChange={change}
			/>
			<output data-testid="plan">{JSON.stringify(condition) ?? ""}</output>
		</>
	);
}
function itemAt(items: HTMLElement[], index: number) {
	const item = items[index];
	if (!item) throw new Error(`Missing control at index ${index}`);
	return item;
}

function open(live = false) {
	renderLocalized(<Example live={live} />);
	const details = screen.getByText("Input conditions").closest("details");
	if (!details) throw new Error("Missing disclosure");
	details.open = true;
	fireEvent(details, new Event("toggle"));
	fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
}
describe("editing stream conditions", () => {
	it("keeps a comparison when wrapping it with OR and replacing the other alternative", () => {
		open();
		fireEvent.change(screen.getByLabelText("Input attribute"), {
			target: { value: "HEIGHT" },
		});
		fireEvent.change(screen.getByLabelText("Comparison"), {
			target: { value: "GREATER_THAN_OR_EQUAL" },
		});
		fireEvent.change(screen.getByLabelText("Value"), {
			target: { value: "1080" },
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Allow an alternative (OR)" }),
		);
		const alternative = itemAt(screen.getAllByLabelText("Input attribute"), 1);
		fireEvent.change(alternative, { target: { value: "WIDTH" } });
		fireEvent.change(itemAt(screen.getAllByLabelText("Value"), 1), {
			target: { value: "1920" },
		});
		const first = {
			attribute: "HEIGHT",
			operator: "GREATER_THAN_OR_EQUAL",
			value: "1080",
		};
		expect(
			JSON.parse(screen.getByTestId("plan").textContent || "null"),
		).toEqual({
			type: "OR",
			conditions: [
				first,
				{ attribute: "WIDTH", operator: "EQUAL", value: "1920" },
			],
		});
		fireEvent.change(screen.getByLabelText("Match"), {
			target: { value: "AND" },
		});
		fireEvent.click(
			itemAt(screen.getAllByRole("button", { name: "Remove rule" }), 1),
		);
		expect(
			JSON.parse(screen.getByTestId("plan").textContent || "null"),
		).toEqual({
			type: "AND",
			conditions: [first],
		});
		fireEvent.click(
			itemAt(screen.getAllByRole("button", { name: "Remove rule" }), 0),
		);
		expect(screen.getByTestId("plan")).toBeEmptyDOMElement();
	});
	it("shows only available Live video attributes and valid boolean operators", () => {
		open(true);
		expect(
			screen.queryByRole("option", { name: "Duration (seconds)" }),
		).toBeNull();
		expect(screen.queryByRole("option", { name: "Bitrate (bps)" })).toBeNull();
		expect(
			screen.getByRole("option", { name: "Frame rate (fps)" }),
		).toBeInTheDocument();
		expect(
			(screen.getByLabelText("Comparison") as HTMLSelectElement).options,
		).toHaveLength(1);
	});
});
