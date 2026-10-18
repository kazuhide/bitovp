import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import { DetailPopover, KeyValueRows } from "./detail-popover";

/**
 * The primitive behind the "34 observed" class — seven call sites and, before
 * this file, no direct test (review of PR #169, T1). Three contracts:
 * keyboard, escape, and the accessible-name split C1 established — the
 * TRIGGER's name is its visible summary (a screen reader must hear the
 * dashboard's number; voice control must match the visible text), and the
 * LABEL names the opened panel.
 */

function Subject() {
	return (
		<DetailPopover summary="2 settings" label="Encoder-chosen settings">
			<KeyValueRows record={{ bitrate: 4200000, profile: "HIGH" }} />
		</DetailPopover>
	);
}

describe("DetailPopover", () => {
	it("names the trigger by its VISIBLE summary, and the panel by the label", async () => {
		renderLocalized(<Subject />);
		// The C1 contract: the summary is the accessible name — not masked.
		const trigger = screen.getByRole("button", { name: "2 settings" });
		expect(
			screen.queryByRole("button", { name: /encoder-chosen/i }),
		).toBeNull();
		await userEvent.click(trigger);
		// The opened panel carries the label as ITS name (aria-dialog-name).
		expect(
			screen.getByRole("dialog", { name: "Encoder-chosen settings" }),
		).toBeTruthy();
		expect(screen.getByText("4200000")).toBeTruthy();
	});

	it("opens from the keyboard and closes on Escape", async () => {
		renderLocalized(<Subject />);
		await userEvent.tab();
		await userEvent.keyboard("{Enter}");
		expect(await screen.findByText("bitrate")).toBeTruthy();
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByText("bitrate")).toBeNull();
	});

	it("KeyValueRows keeps insertion order when told to — sequences must not scramble", () => {
		// localeCompare turned leg 1…leg 11 into 1, 10, 11, 2 (review I5).
		const record = Object.fromEntries(
			Array.from({ length: 11 }, (_, i) => [`leg ${i + 1}`, i]),
		);
		const { container } = renderLocalized(
			<KeyValueRows record={record} sort={false} />,
		);
		const keys = [...container.querySelectorAll("dt")].map(
			(dt) => dt.textContent,
		);
		expect(keys[0]).toBe("leg 1");
		expect(keys[1]).toBe("leg 2");
		expect(keys[10]).toBe("leg 11");
	});
});
