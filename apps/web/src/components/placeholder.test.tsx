import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Placeholder } from "./placeholder";

describe("Placeholder", () => {
	it("renders title, phase badge, and description", () => {
		render(
			<Placeholder
				title="VMAF Lab"
				phase="P4"
				description="Arrives with P4."
			/>,
		);
		expect(
			screen.getByRole("heading", { name: "VMAF Lab" }),
		).toBeInTheDocument();
		expect(screen.getByText("P4")).toBeInTheDocument();
		expect(screen.getByText("Arrives with P4.")).toBeInTheDocument();
	});
});
