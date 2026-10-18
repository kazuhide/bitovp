import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { PlanPresetsPanel } from "./plan-presets-panel";
import type { PlanEvaluation } from "./plan-preview";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

// The panel only reads evaluation.plan (to POST + diff) and the issue levels —
// a minimal object is enough; diffPlans/canonicalize tolerate non-full plans.
const plan = { planVersion: 1, name: "t" } as unknown;
const validEval = { ok: true, plan, issues: [] } as unknown as PlanEvaluation;
const invalidEval = {
	ok: true,
	plan,
	issues: [{ level: "error", code: "X", message: "bad", path: "x" }],
} as unknown as PlanEvaluation;

afterEach(() => apiFetch.mockReset());

describe("PlanPresetsPanel", () => {
	it("shows Valid ✓, enables Save for a valid plan, and POSTs the preset", async () => {
		apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
			if (url === "/api/presets" && !init) return []; // user-preset list
			if (url === "/api/presets" && init?.method === "POST") {
				return { id: "new", name: "n", description: null, createdAt: "" };
			}
			throw new Error(`unexpected ${url}`);
		});
		renderWithQuery(<PlanPresetsPanel evaluation={validEval} />);

		expect(screen.getByText("Valid ✓")).toBeInTheDocument();
		fireEvent.change(
			screen.getByLabelText(/Preset name/i, {
				selector: "input, select, textarea",
			}),
			{
				target: { value: "my-preset" },
			},
		);
		const save = screen.getByRole("button", { name: /Save as preset/i });
		expect(save).toBeEnabled();
		fireEvent.click(save);
		await waitFor(() => {
			expect(apiFetch).toHaveBeenCalledWith(
				"/api/presets",
				expect.objectContaining({ method: "POST" }),
			);
		});
	});

	it("disables Save and shows the issue count for an invalid plan", async () => {
		apiFetch.mockResolvedValue([]);
		renderWithQuery(<PlanPresetsPanel evaluation={invalidEval} />);
		expect(screen.getByText(/1 issue/i)).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Save as preset/i }),
		).toBeDisabled();
	});

	it("renders a field-level diff against a selected sample baseline", async () => {
		apiFetch.mockImplementation(async (url: string) => {
			if (url === "/api/presets") return [];
			if (url.startsWith("/api/sample-presets/")) {
				return { planVersion: 1, name: "different" };
			}
			throw new Error(`unexpected ${url}`);
		});
		renderWithQuery(<PlanPresetsPanel evaluation={validEval} />);

		const select = screen.getByLabelText(/Baseline preset/i, {
			selector: "select",
		}) as HTMLSelectElement;
		const sampleOption = select.querySelector(
			'optgroup[label="Samples"] option',
		) as HTMLOptionElement;
		fireEvent.change(select, { target: { value: sampleOption.value } });

		// name differs ("different" → "t"), so the diff panel renders.
		await waitFor(() =>
			expect(screen.getByTestId("preset-diff")).toBeInTheDocument(),
		);
	});
});
