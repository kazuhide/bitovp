import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DeleteResourceButton } from "@/components/delete-resource-button";
import { Field, FieldRow, FieldRowAction } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { renderLocalized as render } from "@/test/render";

/**
 * Battery batch 2b : shared components no test had rendered
 * directly. `DeleteResourceButton` guards every destructive action in the
 * app, so its three postures — disabled-with-reason, confirm-then-delete,
 * and error — are each pinned; a delete that fires WITHOUT the dialog
 * confirmation is the failure mode the component exists to prevent.
 */

describe("DeleteResourceButton (ledger #149 batch 2b)", () => {
	const base = {
		resourceLabel: "job",
		confirmTitle: "Delete this job?",
		confirmDescription: "Removes the local record.",
	};

	it("disabled: explains itself and never opens the dialog", () => {
		const onConfirm = vi.fn();
		render(
			<DeleteResourceButton
				{...base}
				disabled
				disabledReason="Stop it before deleting"
				onConfirm={onConfirm}
			/>,
		);
		const button = screen.getByRole("button");
		expect(button).toBeDisabled();
		expect(screen.getByRole("tooltip")).toHaveTextContent(
			"Stop it before deleting",
		);
		fireEvent.click(button);
		expect(screen.queryByText("Delete this job?")).toBeNull();
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it("delete requires the dialog's confirmation — the trigger alone does nothing", () => {
		const onConfirm = vi.fn();
		render(<DeleteResourceButton {...base} onConfirm={onConfirm} />);
		fireEvent.click(screen.getByRole("button", { name: "Delete job" }));
		// The trigger only OPENS the dialog.
		expect(screen.getByText("Delete this job?")).toBeInTheDocument();
		expect(onConfirm).not.toHaveBeenCalled();
		// Cancel closes without deleting.
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onConfirm).not.toHaveBeenCalled();
		// Re-open and confirm — only now does the delete run. The trigger's
		// accessible name is "Delete job" (aria-label), so bare "Delete" is
		// the dialog's confirm button and nothing else.
		fireEvent.click(screen.getByRole("button", { name: "Delete job" }));
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		expect(onConfirm).toHaveBeenCalledOnce();
	});

	it("surfaces the mutation error under the trigger", () => {
		render(
			<DeleteResourceButton
				{...base}
				error="delete failed: 409"
				onConfirm={vi.fn()}
			/>,
		);
		expect(screen.getByRole("alert")).toHaveTextContent("delete failed: 409");
	});
});

describe("FieldRow / FieldRowAction (ledger #149 batch 2b)", () => {
	it("mounts labeled fields beside a row action", () => {
		render(
			<FieldRow>
				<Field label="Bucket" htmlFor="cm-bucket">
					<Input id="cm-bucket" />
				</Field>
				<FieldRowAction>
					<button type="button">Remove</button>
				</FieldRowAction>
			</FieldRow>,
		);
		expect(screen.getByLabelText("Bucket")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
	});
});
