import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { CopyableId } from "./copyable-id";

/**
 * : the linked variant. The value becomes an in-page anchor while
 * the COPY affordance stays its own button — one control, one action. The
 * component's first test file; the rendered-caller pin (tab switch on a real
 * chip) lives in job-detail.test.tsx.
 */

describe("CopyableId", () => {
	it("renders a link + a separate copy button when href is given", async () => {
		const onNavigate = vi.fn();
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.assign(navigator, { clipboard: { writeText } });
		renderLocalized(
			<CopyableId
				value="st-1"
				label="Stream id"
				href="#resource-stream_v"
				onNavigate={onNavigate}
			/>,
		);
		const link = screen.getByRole("link", { name: "st-1" });
		expect(link).toHaveAttribute("href", "#resource-stream_v");
		await userEvent.click(link);
		expect(onNavigate).toHaveBeenCalledWith("#resource-stream_v");
		// The copy button is a SIBLING — clicking it copies and does not navigate.
		await userEvent.click(
			screen.getByRole("button", { name: /Copy Stream id: st-1/ }),
		);
		expect(writeText).toHaveBeenCalledWith("st-1");
		expect(onNavigate).toHaveBeenCalledTimes(1);
	});

	it("a bare href WITHOUT onNavigate keeps native navigation (review-181 F3)", async () => {
		// Unconditional preventDefault made this a dead link: the only caller
		// today passes both props, but the component declares them independent.
		renderLocalized(<CopyableId value="st-2" href="#resource-x" />);
		const link = screen.getByRole("link", { name: "st-2" });
		const click = new MouseEvent("click", { bubbles: true, cancelable: true });
		link.dispatchEvent(click);
		expect(click.defaultPrevented).toBe(false);
	});

	it("stays a single copy button without href", () => {
		renderLocalized(<CopyableId value="enc-9" />);
		expect(screen.queryByRole("link")).toBeNull();
		expect(screen.getByRole("button", { name: /enc-9/ })).toBeInTheDocument();
	});
});
