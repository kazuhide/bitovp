import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./coverage-client", () => ({
	ApiCoverageClient: () => <div>Historical API survey</div>,
}));

import ApiCoveragePage from "./page";

describe("ApiCoveragePage", () => {
	it("renders the coverage screen rather than redirecting to Settings", () => {
		render(<ApiCoveragePage />);
		expect(screen.getByText("Historical API survey")).toBeInTheDocument();
	});
});
