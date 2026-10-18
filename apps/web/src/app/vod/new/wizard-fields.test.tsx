import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import { CodesInput } from "./wizard-fields";

function Harness() {
	const [value, setValue] = useState<string[] | undefined>(["ja"]);
	return (
		<>
			<CodesInput id="codes" value={value} onChange={setValue} />
			<button type="button" onClick={() => setValue(["en", "fr"])}>
				Import
			</button>
			<button type="button" onClick={() => setValue(undefined)}>
				Reset
			</button>
			<output>{JSON.stringify(value ?? [])}</output>
		</>
	);
}

describe("codes input", () => {
	it("retains comma input and reflects replacement/reset instead of stale text", async () => {
		const user = userEvent.setup();
		renderLocalized(<Harness />);
		const input = screen.getByPlaceholderText("ja, ko");
		await user.type(input, ", ko,");
		expect(input).toHaveValue("ja, ko,");
		expect(screen.getByRole("status")).toHaveTextContent('["ja","ko"]');
		await user.click(screen.getByRole("button", { name: "Import" }));
		expect(input).toHaveValue("en, fr");
		await user.click(screen.getByRole("button", { name: "Reset" }));
		expect(input).toHaveValue("");
	});
});
