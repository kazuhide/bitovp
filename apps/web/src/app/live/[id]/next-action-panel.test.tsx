import { type LiveNextActionInput, liveNextAction } from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { messagesFor, translate } from "@/lib/i18n";
import { renderLocalized } from "@/test/render";
import { NextActionPanel } from "./next-action-panel";

const running: LiveNextActionInput = {
	status: "RUNNING",
	ingestConnected: true,
	hasEncoding: true,
	playableCount: "unknown",
	armedStartCount: 0,
	overdueArmedCount: 0,
	openAlerts: 0,
};

const failedStart: LiveNextActionInput = {
	...running,
	status: "ERROR",
	hasEncoding: false,
};

it.each([
	["en", "Step log"],
	["ja", "ステップログへ"],
] as const)("links a failed start directly to the step log in %s", (locale, label) => {
	const onJump = vi.fn();
	renderLocalized(
		<NextActionPanel action={liveNextAction(failedStart)} onJump={onJump} />,
		locale,
	);
	const link = screen.getByRole("link", { name: label });
	expect(link).toHaveAttribute("href", "#sec-steps");
	fireEvent.click(link);
	expect(onJump).toHaveBeenCalledWith(expect.anything(), "sec-steps");
});

it.each([
	{ hasEncoding: true, stepsAvailable: true },
	{ hasEncoding: false, stepsAvailable: false },
])("omits the recovery link with hasEncoding=$hasEncoding and stepsAvailable=$stepsAvailable", ({
	hasEncoding,
	stepsAvailable,
}) => {
	renderLocalized(
		<NextActionPanel
			action={liveNextAction({ ...failedStart, hasEncoding })}
			stepsAvailable={stepsAvailable}
		/>,
	);
	expect(screen.queryByRole("link")).toBeNull();
});

it.each([
	[{ readOnly: true }, "#sec-runs"],
	[{ inputUnconfirmed: true }, "#sec-heartbeat"],
] as const)("keeps the special recovery link for %j", (props, href) => {
	renderLocalized(
		<NextActionPanel action={liveNextAction(failedStart)} {...props} />,
	);
	expect(screen.getByRole("link")).toHaveAttribute("href", href);
});

it.each([
	"en",
	"ja",
] as const)("directs unresolved playback links to output evidence with neutral copy in %s", (locale) => {
	const onJump = vi.fn();
	renderLocalized(
		<NextActionPanel action={liveNextAction(running)} onJump={onJump} />,
		locale,
	);
	const text = (key: Parameters<typeof translate>[1]) =>
		translate(messagesFor(locale), key);
	const region = screen.getByRole("region", {
		name: text("nextAction.regionLabel"),
	});
	expect(region).toHaveAttribute("data-next-action", "OUTPUT_UNKNOWN");
	expect(region).not.toHaveClass("border-amber-500/40");
	expect(
		screen.getByRole("heading", {
			name: text("nextAction.outputUnknownTitle"),
		}),
	).toBeVisible();
	expect(region).toHaveTextContent(text("nextAction.outputUnknownBody"));
	expect(region).not.toHaveTextContent(text("nextAction.outputBody"));
	const link = screen.getByRole("link", { name: text("nextAction.goOutput") });
	expect(link).toHaveAttribute("href", "#sec-origin");
	fireEvent.click(link);
	expect(onJump).toHaveBeenCalledWith(expect.anything(), "sec-origin");
});

it.each([
	[0, "WAIT_FOR_OUTPUT", "nextAction.outputTitle", "sec-manifests"],
	[1, "ON_AIR", "nextAction.onAirTitle", null],
] as const)("keeps measured numeric playback count %s on its ordinary action", (playableCount, code, title, section) => {
	renderLocalized(
		<NextActionPanel action={liveNextAction({ ...running, playableCount })} />,
	);
	expect(screen.getByRole("region", { name: "Next action" })).toHaveAttribute(
		"data-next-action",
		code,
	);
	expect(
		screen.getByRole("heading", { name: translate(messagesFor("en"), title) }),
	).toBeVisible();
	if (section) {
		expect(screen.getByRole("link")).toHaveAttribute("href", `#${section}`);
	} else {
		expect(screen.queryByRole("link")).toBeNull();
	}
});
