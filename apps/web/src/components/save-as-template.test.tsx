import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { SaveAsTemplateButton } from "./save-as-template";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async () => {
	const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
	return {
		ApiError: actual.ApiError,
		apiFetch: (...args: unknown[]) => apiFetch(...args),
	};
});

afterEach(() => apiFetch.mockReset());

describe("SaveAsTemplateButton (ledger #109 §5 save-from-detail)", () => {
	it("saves a LIVE channel plan with its kind and confirms by name", async () => {
		apiFetch.mockResolvedValueOnce({ id: "p1", name: "eve-show" });
		renderWithQuery(
			<SaveAsTemplateButton
				kind="LIVE_PLAN"
				plan={{ planVersion: 1, name: "eve-show" }}
				defaultName="eve-show"
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /Save as template/i }));
		const name = (await screen.findByLabelText(
			/Template name/i,
		)) as HTMLInputElement;
		expect(name.value).toBe("eve-show");
		// The dialog's confirm is the second button with the same label.
		const buttons = screen.getAllByRole("button", {
			name: /Save as template/i,
		});
		fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
		await waitFor(() => {
			expect(
				screen.getByText(/Saved as template .eve-show./i),
			).toBeInTheDocument();
		});
		const call = apiFetch.mock.calls.find(([url]) => url === "/api/presets");
		if (!call) {
			throw new Error("POST never fired");
		}
		const payload = JSON.parse((call[1] as RequestInit).body as string) as {
			kind?: string;
			name: string;
		};
		expect(payload.kind).toBe("LIVE_PLAN");
		expect(payload.name).toBe("eve-show");
	});

	it("omits kind for a VOD job (the FULL_PLAN contract is untouched) and surfaces a 409 verbatim", async () => {
		const { ApiError } =
			await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
		apiFetch.mockRejectedValueOnce(
			new ApiError(409, "A preset with that name exists"),
		);
		renderWithQuery(
			<SaveAsTemplateButton
				kind="FULL_PLAN"
				plan={{ planVersion: 1 }}
				defaultName="taken"
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /Save as template/i }));
		const buttons = await screen.findAllByRole("button", {
			name: /Save as template/i,
		});
		fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
		expect(
			await screen.findByText(/A preset with that name exists/i),
		).toBeInTheDocument();
		const call = apiFetch.mock.calls.find(([url]) => url === "/api/presets");
		if (!call) {
			throw new Error("POST never fired");
		}
		const payload = JSON.parse((call[1] as RequestInit).body as string) as {
			kind?: string;
		};
		expect(payload.kind).toBeUndefined();
	});
});
