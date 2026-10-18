import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderLocalized as render } from "@/test/render";
import { Dialog } from "./dialog";
import { HelpOverlay } from "./help-overlay";
import { InfoHint } from "./info-hint";

let anchor: DOMRect;
let contentHeight: number;
let observeResize: (() => void) | undefined;

it("closes nested help on Escape without closing the shared modal Dialog", async () => {
	const onOpenChange = vi.fn();
	render(
		<Dialog open onOpenChange={onOpenChange} title="Edit profile">
			<HelpOverlay label="Profile help">Profile details</HelpOverlay>
			<button type="button">Next</button>
		</Dialog>,
	);
	const trigger = screen.getByRole("button", { name: "Profile help" });
	fireEvent.click(trigger);
	expect(screen.getByRole("note")).toHaveFocus();
	fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
	expect(screen.queryByRole("note")).toBeNull();
	expect(onOpenChange).not.toHaveBeenCalled();
	expect(screen.getByRole("button", { name: "Next" })).toBeVisible();
	await waitFor(() => expect(trigger).toHaveFocus());
});

it.each([
	"hint",
	"help",
] as const)("keeps pinned %s accessible and scrollable inside a modal Dialog", async (kind) => {
	contentHeight = 700;
	const onOpenChange = vi.fn();
	render(
		<Dialog open onOpenChange={onOpenChange} title="Edit profile">
			{kind === "hint" ? (
				<InfoHint label="Profile help" text="Long profile details" />
			) : (
				<HelpOverlay label="Profile help">
					Long profile details <a href="#details">Details</a>
				</HelpOverlay>
			)}
			<button type="button">Next</button>
		</Dialog>,
	);
	const trigger = screen.getByRole("button", { name: "Profile help" });
	await userEvent.click(trigger);
	const panel = screen.getByRole(kind === "hint" ? "tooltip" : "note");
	await waitFor(() => coordinates(panel), { timeout: 1000 });
	expect(panel.closest('[aria-hidden="true"]')).toBeNull();
	expect(panel.style.pointerEvents).toBe("auto");
	Object.defineProperty(panel, "scrollHeight", { value: 700 });
	expect(fireEvent.wheel(panel, { deltaY: 80, cancelable: true })).toBe(true);
	fireEvent.touchStart(panel, {
		changedTouches: [{ clientX: 0, clientY: 100 }],
	});
	expect(
		fireEvent.touchMove(panel, {
			changedTouches: [{ clientX: 0, clientY: 80 }],
			cancelable: true,
		}),
	).toBe(true);
	if (kind === "help") {
		await userEvent.tab();
		expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
		await userEvent.tab();
		expect(screen.getByRole("link", { name: "Details" })).toHaveFocus();
	}
	await userEvent.keyboard("{Escape}");
	await waitFor(() => expect(trigger).toHaveFocus());
	expect(onOpenChange).not.toHaveBeenCalled();
	expect(screen.getByRole("button", { name: "Next" })).toBeVisible();
});

beforeEach(() => {
	anchor = new DOMRect(100, 80, 14, 14);
	contentHeight = 60;
	vi.stubGlobal("innerWidth", 640);
	vi.stubGlobal("innerHeight", 480);
	const observers: (() => void)[] = [];
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: ResizeObserverCallback) {
				observers.push(() => callback([], this as unknown as ResizeObserver));
			}
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	observeResize = () => {
		for (const callback of observers) callback();
	};
	const dimensions = (element: HTMLElement): DOMRect => {
		if (element.hasAttribute("aria-label") && element.tagName === "BUTTON")
			return anchor;
		if (element === document.documentElement || element === document.body)
			return new DOMRect(0, 0, window.innerWidth, window.innerHeight);
		const content = element.matches('[role="note"], [role="tooltip"]')
			? element
			: element.querySelector<HTMLElement>('[role="note"], [role="tooltip"]');
		if (content) {
			const wrapper = content.parentElement;
			const availableWidth = Number.parseFloat(
				wrapper?.style.getPropertyValue("--radix-popper-available-width") ?? "",
			);
			const availableHeight = Number.parseFloat(
				wrapper?.style.getPropertyValue("--radix-popper-available-height") ??
					"",
			);
			return new DOMRect(
				0,
				0,
				Math.max(
					1,
					Math.min(
						content.getAttribute("role") === "note" ? 320 : 256,
						availableWidth || Infinity,
					),
				),
				Math.max(1, Math.min(contentHeight, availableHeight || Infinity)),
			);
		}
		return new DOMRect();
	};
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
		function (this: HTMLElement) {
			return dimensions(this);
		},
	);
	for (const property of [
		"offsetWidth",
		"offsetHeight",
		"clientWidth",
		"clientHeight",
	] as const) {
		vi.spyOn(HTMLElement.prototype, property, "get").mockImplementation(
			function (this: HTMLElement) {
				return property.endsWith("Width")
					? dimensions(this).width
					: dimensions(this).height;
			},
		);
	}
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	observeResize = undefined;
});

function setup(kind: "hint" | "help") {
	render(
		<div data-testid="scroller" style={{ overflow: "hidden" }}>
			{kind === "hint" ? (
				<InfoHint label="Help" text="Long help text" />
			) : (
				<HelpOverlay label="Help">Long help text</HelpOverlay>
			)}
		</div>,
	);
	const trigger = screen.getByRole("button", { name: "Help" });
	fireEvent.click(trigger);
	return {
		trigger,
		panel: screen.getByRole(kind === "hint" ? "tooltip" : "note"),
	};
}
function coordinates(panel: HTMLElement) {
	const transform = panel.parentElement?.style.transform ?? "";
	const match = transform.match(/translate\(([\d.-]+)px, ([\d.-]+)px\)/);
	expect(match, "popup has completed measured positioning").not.toBeNull();
	return { left: Number(match?.[1]), top: Number(match?.[2]) };
}
function expectWithin(
	panel: HTMLElement,
	width: number,
	height: number,
	x = 0,
	y = 0,
) {
	const { left, top } = coordinates(panel);
	const rect = panel.getBoundingClientRect();
	expect(left).toBeGreaterThanOrEqual(x + 8);
	expect(top).toBeGreaterThanOrEqual(y + 8);
	expect(left + rect.width).toBeLessThanOrEqual(x + width - 8);
	expect(top + rect.height).toBeLessThanOrEqual(y + height - 8);
}

describe.each(["hint", "help"] as const)("%s viewport placement", (kind) => {
	it.each([
		["top left", 0, 0],
		["top right", 306, 0],
		["bottom left", 0, 226],
		["bottom right", 306, 226],
	] as const)("escapes clipping and fits at the %s corner", async (_name, left, top) => {
		vi.stubGlobal("innerWidth", 320);
		vi.stubGlobal("innerHeight", 240);
		anchor = new DOMRect(left, top, 14, 14);
		const { panel } = setup(kind);
		expect(panel.parentElement?.parentElement).toBe(document.body);
		expect(panel.parentElement?.style.position).toBe("fixed");
		await waitFor(() => expectWithin(panel, 320, 240), { timeout: 1000 });
		const panelTop = coordinates(panel).top;
		if (top === 0) expect(panelTop).toBeGreaterThanOrEqual(anchor.bottom);
		else expect(panelTop + contentHeight).toBeLessThanOrEqual(anchor.top);
	});
	it("limits long help to a narrow, short viewport with scrolling", async () => {
		vi.stubGlobal("innerWidth", 160);
		vi.stubGlobal("innerHeight", 100);
		anchor = new DOMRect(120, 30, 14, 14);
		contentHeight = 500;
		const { panel } = setup(kind);
		await waitFor(() => expectWithin(panel, 160, 100), { timeout: 1000 });
		expect(panel.getBoundingClientRect().height).toBeLessThan(500);
		expect(panel.style.overflowY).toBe("auto");
	});
	it("follows nested scroll, viewport resize and changed content size", async () => {
		const { panel } = setup(kind);
		await waitFor(() => coordinates(panel), { timeout: 1000 });
		const initialTop = coordinates(panel).top;
		anchor = new DOMRect(100, 180, 14, 14);
		fireEvent.scroll(screen.getByTestId("scroller"));
		await waitFor(() => expect(coordinates(panel).top).toBe(initialTop + 100));
		vi.stubGlobal("innerWidth", 240);
		vi.stubGlobal("innerHeight", 240);
		fireEvent(window, new Event("resize"));
		await waitFor(() => expectWithin(panel, 240, 240), { timeout: 1000 });
		contentHeight = 400;
		act(() => observeResize?.());
		await waitFor(() => expectWithin(panel, 240, 240), { timeout: 1000 });
		expect(panel.getBoundingClientRect().height).toBeLessThan(400);
	});
	it("uses the visible viewport after zoom, pan or the keyboard changes it", async () => {
		const viewport = Object.assign(new EventTarget(), {
			scale: 1,
			width: 360,
			height: 280,
			offsetLeft: 0,
			offsetTop: 0,
		});
		vi.stubGlobal("visualViewport", viewport);
		const { panel } = setup(kind);
		viewport.width = 200;
		viewport.height = 120;
		viewport.offsetLeft = 18;
		viewport.offsetTop = 30;
		act(() => viewport.dispatchEvent(new Event("resize")));
		await waitFor(() => expectWithin(panel, 200, 120, 18, 30), {
			timeout: 1000,
		});
		viewport.offsetLeft = 40;
		act(() => viewport.dispatchEvent(new Event("scroll")));
		await waitFor(() => expectWithin(panel, 200, 120, 40, 30), {
			timeout: 1000,
		});
	});
});

it("previews help on hover/focus without stealing focus, stays hoverable and pins on tap", async () => {
	render(<HelpOverlay label="Help">Readable help</HelpOverlay>);
	const trigger = screen.getByRole("button", { name: "Help" });
	fireEvent.mouseEnter(trigger);
	const preview = screen.getByRole("note");
	expect(preview).not.toHaveFocus();
	fireEvent.mouseLeave(trigger);
	fireEvent.mouseEnter(preview);
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 180));
	});
	expect(preview).toBeVisible();
	fireEvent.click(trigger);
	expect(screen.getByRole("note")).toHaveFocus();
	fireEvent.mouseLeave(screen.getByRole("note"));
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 180));
	});
	expect(screen.getByRole("note")).toBeVisible();
	fireEvent.keyDown(document, { key: "Escape" });
	expect(screen.queryByRole("note")).toBeNull();
	await waitFor(() => expect(trigger).toHaveFocus());
	fireEvent.blur(trigger);
	fireEvent.focus(trigger);
	expect(screen.getByRole("note")).not.toHaveFocus();
});
