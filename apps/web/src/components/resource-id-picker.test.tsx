import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import {
	type ResourceIdCandidate,
	ResourceIdPicker,
} from "@/components/resource-id-picker";
import { Field } from "@/components/ui/field";
import { renderLocalized as render } from "@/test/render";

const ID_A = "11112222-3333-4444-8555-666677778888";
const ID_B = "aaaabbbb-cccc-4ddd-8eee-ffff00001111";
const OUTSIDE_ID = "99998888-7777-4666-8555-444433332222";

const CANDIDATES: ResourceIdCandidate[] = [
	{ id: ID_A, label: "studio-a", badge: "RUNNING", tone: "ok" },
	{ id: ID_B, label: "overflow-feed", detail: "created yesterday" },
];

/** Mirrors the real callers: the picker sits inside a Field that labels it. */
function Harness({
	initial = "",
	candidates = CANDIDATES,
	isLoading = false,
	errorMessage,
	truncatedMessage,
}: {
	initial?: string;
	candidates?: ResourceIdCandidate[];
	isLoading?: boolean;
	errorMessage?: string;
	truncatedMessage?: string;
}) {
	const [value, setValue] = useState(initial);
	return (
		<>
			<Field label="Encoding id" htmlFor="rp-id">
				<ResourceIdPicker
					inputId="rp-id"
					value={value}
					onChange={setValue}
					candidates={candidates}
					isLoading={isLoading}
					emptyMessage="No candidates — paste an encoding id below."
					listLabel="Live channels in this app"
					copyLabel="encoding id"
					{...(errorMessage ? { errorMessage } : {})}
					{...(truncatedMessage ? { truncatedMessage } : {})}
				/>
			</Field>
			<output data-testid="value">{value}</output>
		</>
	);
}

describe("ResourceIdPicker", () => {
	it("renders candidates by NAME (plus chip and copyable id), not as bare UUIDs", () => {
		render(<Harness />);
		expect(screen.getByRole("radio", { name: /studio-a/ })).toBeInTheDocument();
		expect(screen.getByText("RUNNING")).toBeInTheDocument();
		expect(screen.getByText("created yesterday")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: `Copy encoding id: ${ID_A}` }),
		).toBeInTheDocument();
	});

	it("selecting a candidate sets the field the form submits", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		await user.click(screen.getByRole("radio", { name: /overflow-feed/ }));
		expect(screen.getByTestId("value").textContent).toBe(ID_B);
		expect(screen.getByLabelText("Encoding id")).toHaveValue(ID_B);
		expect(screen.getByRole("radio", { name: /overflow-feed/ })).toBeChecked();
	});

	it("keeps the paste fallback: free text sets the field, and a pasted match selects its row", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		const field = screen.getByLabelText("Encoding id");

		await user.type(field, OUTSIDE_ID);
		expect(screen.getByTestId("value").textContent).toBe(OUTSIDE_ID);
		expect(
			screen.getByText(/Using a pasted id — not in the list above/),
		).toBeInTheDocument();

		await user.clear(field);
		await user.type(field, ID_A);
		expect(screen.getByRole("radio", { name: /studio-a/ })).toBeChecked();
		expect(screen.queryByText(/Using a pasted id/)).not.toBeInTheDocument();
	});

	it("a preset value outside the list survives (never silently cleared)", () => {
		render(<Harness initial={OUTSIDE_ID} />);
		expect(screen.getByLabelText("Encoding id")).toHaveValue(OUTSIDE_ID);
		expect(screen.getByTestId("value").textContent).toBe(OUTSIDE_ID);
		expect(screen.getByRole("radio", { name: /studio-a/ })).not.toBeChecked();
		expect(
			screen.getByText(/Using a pasted id — not in the list above/),
		).toBeInTheDocument();
	});

	it("a failed list degrades to free text with the reason visible", async () => {
		const user = userEvent.setup();
		render(
			<Harness
				candidates={[]}
				errorMessage="Could not list this app's live channels (Bitmovin API error (502))"
			/>,
		);
		expect(screen.queryAllByRole("radio")).toHaveLength(0);
		expect(
			screen.getByText(/Bitmovin API error \(502\)\) — paste an id below/),
		).toBeInTheDocument();
		// One explanation, not two: the empty-list copy would contradict it.
		expect(screen.queryByText(/No candidates/)).not.toBeInTheDocument();

		await user.type(screen.getByLabelText("Encoding id"), OUTSIDE_ID);
		expect(screen.getByTestId("value").textContent).toBe(OUTSIDE_ID);
	});

	// The error is a BANNER, never a replacement for the list: a caller may
	// merge candidates from a second, independent source (the unassign dialog
	// feeds `extraCandidates` off the stream-key list), and those survive the
	// failure of the query the message is about. Hiding them would drop ids the
	// app is already rendering on screen.
	it("keeps candidates from another source pickable when one list fails", async () => {
		const user = userEvent.setup();
		render(
			<Harness
				candidates={[{ id: ID_B, label: "Holds pool-key", badge: "1 key" }]}
				errorMessage="Could not list this app's live channels (Bitmovin API error (502))"
			/>,
		);
		expect(
			screen.getByText(/Bitmovin API error \(502\)\) — paste an id below/),
		).toBeInTheDocument();

		const radio = screen.getByRole("radio", { name: /Holds pool-key/ });
		await user.click(radio);
		expect(radio).toBeChecked();
		expect(screen.getByTestId("value").textContent).toBe(ID_B);
		expect(screen.getByLabelText("Encoding id")).toHaveValue(ID_B);
	});

	it("says so when there are no candidates, and when the list is knowingly partial", () => {
		const { unmount } = render(<Harness candidates={[]} />);
		expect(
			screen.getByText("No candidates — paste an encoding id below."),
		).toBeInTheDocument();
		unmount();

		render(<Harness truncatedMessage="Showing the 100 most recent channels" />);
		expect(
			screen.getByText(/Showing the 100 most recent channels/),
		).toBeInTheDocument();
	});

	it("shows a busy placeholder instead of an empty list while loading", () => {
		render(<Harness candidates={[]} isLoading />);
		expect(
			screen.getByRole("status", { name: /Loading Live channels/ }),
		).toBeInTheDocument();
		expect(screen.queryByText(/No candidates/)).not.toBeInTheDocument();
	});
});
