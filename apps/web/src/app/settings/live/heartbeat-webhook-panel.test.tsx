import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery as wrap } from "@/test/render";

vi.mock("@/lib/auth/use-role-access", () => import("@/test/owner-role-access"));
const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import {
	HeartbeatWebhookPanel,
	type LiveHeartbeatSettingsView,
	parseHeartbeatForm,
} from "./heartbeat-webhook-panel";

const BOUNDS = { minIntervalS: 1, maxIntervalS: 3600, maxIdleMinutes: 10080 };

function view(
	over: Partial<LiveHeartbeatSettingsView> = {},
): LiveHeartbeatSettingsView {
	return {
		effective: { mode: "PER_ENCODING", intervalS: 20, idleMinutes: 60 },
		source: "env",
		stored: null,
		// a stored pair implies a row unless the arm says otherwise
		hasRow: (over.stored ?? null) !== null,
		envDefault: { mode: "PER_ENCODING", intervalS: 20, idleMinutes: 60 },
		envSource: "env",
		bounds: BOUNDS,
		...over,
	};
}

/** Records every call; GET answers `current`, PUT/DELETE answer `after`. */
function mockApi(
	current: LiveHeartbeatSettingsView,
	after: LiveHeartbeatSettingsView,
) {
	const calls: { method: string; body: unknown }[] = [];
	apiFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
		if (String(url) !== "/api/settings/live-heartbeat") {
			throw new Error(`unexpected ${String(url)}`);
		}
		const method = init?.method ?? "GET";
		calls.push({
			method,
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		});
		return method === "GET" ? current : after;
	});
	return calls;
}

describe("Settings → Live heartbeat cadence panel", () => {
	it.each([
		"en",
		"ja",
	] as const)("uses only per-encoding registration with no idle control (%s)", async (locale) => {
		const calls = mockApi(view(), view());
		wrap(<HeartbeatWebhookPanel />, locale);
		await screen.findByTestId("hb-effective");
		expect(screen.queryByRole("combobox")).toBeNull();
		expect(screen.getAllByRole("textbox")).toHaveLength(1);
		expect(
			screen.queryByLabelText(/Retire after idle|アイドル解除/),
		).toBeNull();
		await userEvent.click(
			screen.getByRole("button", {
				name:
					locale === "en"
						? "Heartbeat webhook cadence — more information"
						: "「heartbeat webhook の間隔」の説明",
			}),
		);
		expect(
			screen.getByText(
				locale === "en"
					? /registered separately for each/
					: /ライブ配信ごとに個別登録/,
			),
		).toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", { name: locale === "en" ? "Save" : "保存" }),
		);
		await waitFor(() =>
			expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
				mode: "PER_ENCODING",
				intervalS: 20,
				idleMinutes: 60,
			}),
		);
		expect(await screen.findByRole("status")).toHaveTextContent(
			locale === "en"
				? "Existing runs keep their interval"
				: "実行中の配信の間隔は変わりません",
		);
	});
	it("shows the effective cadence with its source and the deployment default, and fills the form from the effective value", async () => {
		mockApi(view(), view());
		wrap(<HeartbeatWebhookPanel />);
		expect(await screen.findByTestId("hb-effective")).toHaveTextContent(
			"Configured interval: 20 s — from the deployment environment",
		);
		expect(screen.getByTestId("hb-env-default")).toHaveTextContent(
			"Deployment default: 20 s",
		);
		expect(screen.getByLabelText("Requested interval (seconds)")).toHaveValue(
			"20",
		);

		// nothing stored yet: there is nothing to revert
		expect(
			screen.getByRole("button", { name: "Use the deployment default" }),
		).toBeDisabled();
	});

	it("says when the hook is off and which source turned it off", async () => {
		mockApi(
			view({
				effective: { mode: "PER_ENCODING", intervalS: 0, idleMinutes: 60 },
				source: "gui",
				stored: { mode: "PER_ENCODING", intervalS: 0, idleMinutes: 60 },
			}),
			view(),
		);
		wrap(<HeartbeatWebhookPanel />);
		expect(await screen.findByTestId("hb-effective")).toHaveTextContent(
			"Effective now: no hook registered — set on this screen",
		);
		expect(
			screen.getByRole("button", { name: "Use the deployment default" }),
		).toBeEnabled();
	});

	it("saves whole numbers as a PUT of the exact pair and shows the returned (gui) view", async () => {
		const saved = view({
			effective: { mode: "PER_ENCODING", intervalS: 30, idleMinutes: 120 },
			source: "gui",
			stored: { mode: "PER_ENCODING", intervalS: 30, idleMinutes: 120 },
		});
		const calls = mockApi(
			view({
				effective: { mode: "PER_ENCODING", intervalS: 20, idleMinutes: 120 },
			}),
			saved,
		);
		const user = userEvent.setup();
		wrap(<HeartbeatWebhookPanel />);
		const interval = await screen.findByLabelText(
			"Requested interval (seconds)",
		);
		await user.clear(interval);
		await user.type(interval, "30");
		await user.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(calls.some((c) => c.method === "PUT")).toBe(true),
		);
		expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
			mode: "PER_ENCODING",
			intervalS: 30,
			idleMinutes: 120,
		});
		expect(await screen.findByRole("status")).toHaveTextContent(
			"Saved. The interval applies to new runs. Existing runs keep their interval.",
		);
		expect(screen.getByTestId("hb-effective")).toHaveTextContent(
			"Configured interval: 30 s — set on this screen",
		);
	});

	it("disables Save and explains while the form is not a valid pair — no request leaves", async () => {
		const calls = mockApi(view(), view());
		const user = userEvent.setup();
		wrap(<HeartbeatWebhookPanel />);
		const interval = await screen.findByLabelText(
			"Requested interval (seconds)",
		);
		await user.clear(interval);
		await user.type(interval, "3601");
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
		expect(screen.getByRole("alert")).toHaveTextContent("Whole numbers only");
		await user.clear(interval);
		await user.type(interval, "2.5");
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
		await user.clear(interval);
		await user.type(interval, "0");
		expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
		expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
	});

	it("reverting sends a DELETE and shows the deployment-sourced view", async () => {
		const calls = mockApi(
			view({
				effective: { mode: "PER_ENCODING", intervalS: 30, idleMinutes: 120 },
				source: "gui",
				stored: { mode: "PER_ENCODING", intervalS: 30, idleMinutes: 120 },
			}),
			view(),
		);
		const user = userEvent.setup();
		wrap(<HeartbeatWebhookPanel />);
		const revert = await screen.findByRole("button", {
			name: "Use the deployment default",
		});
		expect(revert).toBeEnabled();
		await user.click(revert);
		await waitFor(() =>
			expect(calls.some((c) => c.method === "DELETE")).toBe(true),
		);
		expect(await screen.findByRole("status")).toHaveTextContent(
			"Reverted to the deployment default.",
		);
		expect(screen.getByTestId("hb-effective")).toHaveTextContent(
			"Configured interval: 20 s — from the deployment environment",
		);
		expect(screen.getByLabelText("Requested interval (seconds)")).toHaveValue(
			"20",
		);
	});

	it("a stored row that does not parse still offers the revert (hb-sec 3), and a code default is named as such (hb-sec 2)", async () => {
		mockApi(
			view({ source: "default", envSource: "default", hasRow: true }),
			view(),
		);
		wrap(<HeartbeatWebhookPanel />);
		expect(await screen.findByTestId("hb-env-default")).toHaveTextContent(
			"The deployment environment sets nothing; the code default is 20 s",
		);
		expect(
			screen.getByRole("button", { name: "Use the deployment default" }),
		).toBeEnabled();
	});

	it("validates only the editable interval", () => {
		expect(parseHeartbeatForm("0", BOUNDS)).toEqual({ intervalS: 0 });
		expect(parseHeartbeatForm(" 3600 ", BOUNDS)).toEqual({ intervalS: 3600 });
		for (const value of ["3601", "-1", "2.5", "", "abc"])
			expect(parseHeartbeatForm(value, BOUNDS)).toBeNull();
	});
});

it("serializes cadence save and reset and clears saved notice on edits", async () => {
	mockApi(view({ hasRow: true }), view({ hasRow: true }));
	wrap(<HeartbeatWebhookPanel />);
	const input = await screen.findByLabelText("Requested interval (seconds)");
	await userEvent.click(screen.getByRole("button", { name: "Save" }));
	expect(await screen.findByRole("status")).toHaveTextContent(
		"Existing runs keep their interval",
	);
	await userEvent.type(input, "1");
	expect(screen.queryByRole("status")).not.toBeInTheDocument();
	apiFetch.mockImplementation(() => new Promise(() => {}));
	await userEvent.click(screen.getByRole("button", { name: "Save" }));
	await waitFor(() => expect(input).toBeDisabled());
	expect(
		screen.getByRole("button", { name: "Use the deployment default" }),
	).toBeDisabled();
});
