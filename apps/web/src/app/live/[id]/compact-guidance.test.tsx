import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { messagesFor } from "@/lib/i18n";
import { renderLocalized } from "@/test/render";
import { LifecycleStrip } from "./lifecycle-strip";
import { NextActionPanel } from "./next-action-panel";

describe.each(["ja", "en"] as const)("compact Live guidance (%s)", (locale) => {
	const messages = messagesFor(locale);
	it("does not ask a cleanly stopped legacy run to wait for its first provider read", async () => {
		const user = userEvent.setup();
		renderLocalized(
			<LifecycleStrip
				status="STOPPED"
				ingestConnected={false}
				hasEncoding
				provider={{
					unobserved: true,
					unknown: false,
					terminal: false,
					observedAt: null,
					unknownSince: null,
					status: null,
				}}
			/>,
			locale,
		);
		expect(
			screen.queryByText(messages.lifecycle.providerUnobservedHint),
		).toBeNull();
		expect(screen.queryByText(messages.lifecycle.s7Hint)).toBeNull();
		const help = screen.getByRole("button");
		help.focus();
		await user.keyboard("{Enter}");
		expect(screen.getByRole("note")).toHaveTextContent(
			messages.lifecycle.s7Hint,
		);
		expect(screen.getByRole("note")).toHaveFocus();
		expect(screen.getByRole("note").textContent).not.toMatch(
			/Restart resumes|同じエンコーディングを再開/,
		);
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("note")).toBeNull();
		expect(help).toHaveFocus();
	});
	it("keeps re-air explanation behind touch/click help without hiding the heading or changing the action", async () => {
		const user = userEvent.setup();
		renderLocalized(
			<NextActionPanel
				action={{ code: "START_NEW_RUN", tone: "idle", section: "sec-actions" }}
			/>,
			locale,
		);
		expect(
			screen.getByRole("heading", {
				name: messages.nextAction.startNewRunTitle,
			}),
		).toBeVisible();
		expect(screen.getByRole("link")).toHaveAttribute("href", "#sec-actions");
		expect(screen.queryByText(messages.nextAction.startNewRunBody)).toBeNull();
		await user.click(screen.getByRole("button"));
		expect(screen.getByRole("note")).toHaveTextContent(
			messages.nextAction.startNewRunBody,
		);
		expect(
			screen.getByRole("heading", {
				name: messages.nextAction.startNewRunTitle,
			}),
		).toBeVisible();
		await user.click(document.body);
		expect(screen.queryByRole("note")).toBeNull();
		expect(screen.getByRole("link")).toHaveAttribute("href", "#sec-actions");
	});
});
