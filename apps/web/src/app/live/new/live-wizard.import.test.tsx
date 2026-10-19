import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	act,
	fireEvent,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { draftKey, writeWizardDraft } from "@/lib/wizard-draft";
import { renderWithQuery } from "@/test/render";
import { DEFAULT_LIVE_WIZARD_STATE } from "./build-live-plan";
import { LiveWizard } from "./live-wizard";

const { apiFetch, push } = vi.hoisted(() => ({
	apiFetch: vi.fn(),
	push: vi.fn(),
}));
vi.mock("@/lib/api", async (original) => ({
	...(await original<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push, replace: vi.fn() }),
}));
const fixture = JSON.parse(
	readFileSync(
		join(
			__dirname,
			"../../../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
		),
		"utf8",
	),
);
function plan() {
	return {
		...structuredClone(fixture),
		bitmovin: {
			...fixture.bitmovin,
			accountId: "33333333-3333-4333-8333-333333333333",
		},
	};
}
const operatorSession = {
	mode: "users",
	configured: true,
	authenticated: true,
	role: "OPERATOR",
	effectiveUserId: "user",
	organizationId: "org",
	isImpersonating: false,
};
afterEach(() => vi.useRealTimers());
beforeEach(() => {
	localStorage.clear();
	vi.clearAllMocks();
	apiFetch.mockImplementation(async (url: string) =>
		url === "/api/presets"
			? { id: "saved", name: "Reusable Live" }
			: url === "/api/auth/session"
				? operatorSession
				: [],
	);
});
function load(raw: unknown) {
	fireEvent.click(screen.getByRole("button", { name: /Import plan JSON/ }));
	fireEvent.change(screen.getByLabelText("Live channel plan JSON"), {
		target: { value: JSON.stringify(raw) },
	});
	fireEvent.click(screen.getByRole("button", { name: "Load plan" }));
}
it("imports into editable wizard and saves edited plan separately without creating a channel", async () => {
	renderWithQuery(<LiveWizard />);
	load(plan());
	await act(async () => {});
	const name = screen.getByRole("textbox", { name: "Channel name" });
	expect(name).toHaveValue(fixture.name);
	fireEvent.change(name, { target: { value: "Edited imported Live" } });
	fireEvent.click(screen.getByRole("button", { name: /^8\. Review/ }));
	fireEvent.click(
		await screen.findByRole("button", { name: "Save as template" }),
	);
	const dialog = screen.getByRole("dialog");
	fireEvent.change(within(dialog).getByLabelText("Template name"), {
		target: { value: "Reusable Live" },
	});
	fireEvent.click(
		within(dialog).getByRole("button", { name: "Save as template" }),
	);
	await screen.findByText(/Saved as template/);
	const posts = apiFetch.mock.calls.filter(
		([, init]) => init?.method === "POST",
	);
	expect(posts).toHaveLength(1);
	expect(posts[0]?.[0]).toBe("/api/presets");
	expect(JSON.parse(posts[0]?.[1].body)).toMatchObject({
		kind: "LIVE_PLAN",
		plan: { name: "Edited imported Live" },
	});
});
it("retains unrepresented options in raw import and exposes JSON editing without creating a channel", async () => {
	const raw = plan();
	raw.muxings[0].name = "Custom container name unsupported by form";
	renderWithQuery(<LiveWizard />);
	load(raw);
	await act(async () => {});
	expect(screen.queryByRole("textbox", { name: "Channel name" })).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "Edit JSON" }));
	expect(screen.getByLabelText("Live channel plan JSON")).toHaveValue(
		JSON.stringify(raw, null, 2),
	);
	expect(apiFetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
		false,
	);
});

it.each([
	true,
	false,
])("saves a valid raw import without dropping options or injecting an empty account (account=%s)", async (hasAccount) => {
	const raw = plan();
	if (!hasAccount) delete raw.bitmovin.accountId;
	raw.muxings[0].name = "Keep custom muxing name";
	renderWithQuery(<LiveWizard />);
	load(raw);
	await act(async () => {});
	fireEvent.click(
		await screen.findByRole("button", { name: "Save as template" }),
	);
	fireEvent.click(
		within(screen.getByRole("dialog")).getByRole("button", {
			name: "Save as template",
		}),
	);
	await screen.findByText(/Saved as template/);
	const posts = apiFetch.mock.calls.filter(
		([, init]) => init?.method === "POST",
	);
	expect(posts).toHaveLength(1);
	expect(posts[0]?.[0]).toBe("/api/presets");
	expect(JSON.parse(posts[0]?.[1].body).plan).toEqual(raw);
});

it("excludes mapped JSON imports from unrelated new-channel browser drafts", async () => {
	const key = draftKey(["org", "user"], "live", "new");
	writeWizardDraft(
		key,
		"live",
		{ ...DEFAULT_LIVE_WIZARD_STATE, name: "Unrelated draft" },
		0,
	);
	const existing = localStorage.getItem(key);
	apiFetch.mockImplementation(async (url: string) =>
		url === "/api/auth/session"
			? {
					mode: "users",
					configured: true,
					authenticated: true,
					role: "OPERATOR",
					effectiveUserId: "user",
					organizationId: "org",
					isImpersonating: false,
				}
			: url === "/api/live-channels"
				? { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee9" }
				: [],
	);
	renderWithQuery(<LiveWizard />);
	await screen.findByRole("button", { name: "Restore" });
	load(plan());
	expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
	const unrepresented = plan();
	unrepresented.muxings[0].name = "Second import: raw only";
	load(unrepresented);
	fireEvent.click(screen.getByRole("button", { name: "Discard import" }));
	expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
	vi.useFakeTimers();
	fireEvent.change(screen.getByRole("textbox", { name: "Channel name" }), {
		target: { value: "Imported edit" },
	});
	await act(async () => vi.advanceTimersByTime(400));
	expect(localStorage.getItem(key)).toBe(existing);
	vi.useRealTimers();
	fireEvent.click(screen.getByRole("button", { name: /^8\. Review/ }));
	const create = screen.getByRole("button", { name: "Create live channel" });
	await waitFor(() => expect(create).toBeEnabled());
	fireEvent.click(create);
	await waitFor(() =>
		expect(push).toHaveBeenCalledWith(
			"/live/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee9",
		),
	);
	expect(localStorage.getItem(key)).toBe(existing);
});

it.each([
	["VIEWER", false],
	["VIEWER", true],
	["failed-session", false],
	["failed-session", true],
] as const)("hides template saving for %s after import (raw=%s)", async (access, rawMode) => {
	apiFetch.mockImplementation(async (url: string) => {
		if (url === "/api/auth/session") {
			if (access === "failed-session") throw new Error("session unavailable");
			return { ...operatorSession, role: "VIEWER" };
		}
		return [];
	});
	const raw = plan();
	if (rawMode) raw.muxings[0].name = "Keep unrepresented container name";
	const view = renderWithQuery(<LiveWizard />);
	load(raw);
	if (!rawMode)
		fireEvent.click(screen.getByRole("button", { name: /^8\. Review/ }));
	await waitFor(() =>
		expect(view.client.getQueryState(["auth", "session"])?.status).toBe(
			access === "failed-session" ? "error" : "success",
		),
	);
	expect(screen.queryByRole("button", { name: "Save as template" })).toBeNull();
	expect(apiFetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
		false,
	);
});
