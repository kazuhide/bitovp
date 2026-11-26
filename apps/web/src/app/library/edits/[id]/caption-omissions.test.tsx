import { fireEvent, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { CaptionOmissions } from "./caption-omissions";

it("shows omitted source speech as optional context and opens existing manual caption controls", () => {
	const onEdit = vi.fn();
	renderWithQuery(
		<CaptionOmissions
			omissions={[
				{
					segmentIndex: 52,
					sourceStartUs: 369_670_000,
					sourceEndUs: 380_660_000,
					textPreview: " NOO",
					textHash: "a".repeat(64),
					reason: "ZERO_DURATION_NO_ANCHOR",
				},
			]}
			onEdit={onEdit}
		/>,
	);
	expect(screen.getByText("Omitted captions · 1")).toBeInTheDocument();
	expect(screen.queryByRole("alert")).toBeNull();
	const details = screen.getByText("Omitted captions · 1").closest("details");
	expect(details).not.toHaveAttribute("open");
	fireEvent.click(screen.getByText("Omitted captions · 1"));
	expect(screen.getByText("NOO")).toBeInTheDocument();
	expect(screen.getByText("6:09.67–6:20.66")).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Edit captions" }));
	expect(onEdit).toHaveBeenCalledOnce();
});

it("adds no notice when every caption has a measured timing", () => {
	const { container } = renderWithQuery(<CaptionOmissions onEdit={vi.fn()} />);
	expect(container).toBeEmptyDOMElement();
});
