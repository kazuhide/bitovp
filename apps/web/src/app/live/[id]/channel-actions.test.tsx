import type { LiveChannelPlan } from "@bitovp/core";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery as wrap } from "@/test/render";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: routerPush }),
}));

import {
	ChannelCueForm,
	ChannelDangerZone,
	ChannelLifecycleActions,
	DuplicateChannelButton,
} from "./channel-actions";

const CHANNEL_ID = "00000000-0000-4000-8000-0000000000c1";
const RUN_ID = "00000000-0000-4000-8000-0000000000c2";
const rtmpPlan = {
	liveInput: {
		kind: "REDUNDANT_RTMP",
		ingestPoints: [
			{ applicationName: "primary", streamKey: "private-primary" },
			{ applicationName: "backup", streamKey: "private-backup" },
		],
	},
} as LiveChannelPlan;

beforeEach(() => {
	vi.clearAllMocks();
	apiFetch.mockImplementation(async (input: string) =>
		input === "/api/auth/session"
			? {
					mode: "password",
					configured: true,
					authenticated: true,
					loginKind: "password-form",
				}
			: { deleted: true },
	);
});

/**
 *  split the old single `ChannelActions` into four components, so
 * these pins now name the component that OWNS each control. The properties
 * being protected are unchanged — delete is refused while the channel is up,
 * and restart is offered only where it can succeed .
 */
describe("ChannelDangerZone — delete", () => {
	it("disables delete while the channel is RUNNING", () => {
		wrap(<ChannelDangerZone channelId={CHANNEL_ID} status="RUNNING" />);
		expect(
			screen.getByRole("button", { name: /Delete channel \(disabled\)/ }),
		).toBeDisabled();
	});

	it("confirms then DELETEs a STOPPED channel and redirects to /live", async () => {
		wrap(<ChannelDangerZone channelId={CHANNEL_ID} status="STOPPED" />);

		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Delete channel" }));
		await user.click(screen.getByRole("button", { name: "Delete" }));

		await waitFor(() => {
			const call = apiFetch.mock.calls.find(
				(c) =>
					String(c[0]) === `/api/live-channels/${CHANNEL_ID}` &&
					(c[1] as RequestInit)?.method === "DELETE",
			);
			expect(call).toBeTruthy();
		});
		await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/live"));
	});
});

describe("ChannelLifecycleActions — restart is only offered where it can work (ledger #107)", () => {
	it("updates declared points with references and displayed run only", async () => {
		wrap(
			<ChannelLifecycleActions
				channelId={CHANNEL_ID}
				runId={RUN_ID}
				status="RUNNING"
				hasEncoding
				plan={rtmpPlan}
			/>,
		);
		await userEvent.click(
			await screen.findByText("RTMP ingest points", { selector: "summary" }),
		);
		await userEvent.click(screen.getByRole("checkbox", { name: "primary" }));
		await userEvent.click(
			screen.getByRole("button", { name: "Apply selected points" }),
		);
		await screen.findByText("Update queued");
		const call = apiFetch.mock.calls.find(
			([, options]) => options?.method === "POST",
		);
		expect(JSON.parse(call?.[1].body)).toMatchObject({
			action: "update-rtmp-ingest",
			runId: RUN_ID,
			pointIndexes: [1],
			requestId: expect.any(String),
		});
		expect(JSON.stringify(call)).not.toContain("private-");
	});
	it("hides RTMP mutation from viewers", async () => {
		apiFetch.mockResolvedValue({
			mode: "users",
			configured: true,
			authenticated: true,
			loginKind: "password-form",
			role: "VIEWER",
		});
		wrap(
			<ChannelLifecycleActions
				channelId={CHANNEL_ID}
				runId={RUN_ID}
				status="RUNNING"
				hasEncoding
				plan={rtmpPlan}
			/>,
		);
		await waitFor(() =>
			expect(apiFetch).toHaveBeenCalledWith("/api/auth/session", {
				cache: "no-store",
			}),
		);
		expect(screen.queryByText("RTMP ingest points")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Apply selected points" }),
		).not.toBeInTheDocument();
	});
	it("drops selected points when the current run changes and keeps provider errors explicit", async () => {
		apiFetch.mockImplementation(async (url: string) => {
			if (url === "/api/auth/session")
				return {
					mode: "password",
					configured: true,
					authenticated: true,
					loginKind: "password-form",
				};
			throw new Error("unavailable");
		});
		const view = wrap(
			<ChannelLifecycleActions
				channelId={CHANNEL_ID}
				runId={RUN_ID}
				status="RUNNING"
				hasEncoding
				plan={rtmpPlan}
			/>,
		);
		await userEvent.click(
			await screen.findByText("RTMP ingest points", { selector: "summary" }),
		);
		await userEvent.click(screen.getByRole("checkbox", { name: "primary" }));
		await userEvent.click(
			screen.getByRole("button", { name: "Apply selected points" }),
		);
		await screen.findByRole("alert");
		view.rerender(
			<ChannelLifecycleActions
				channelId={CHANNEL_ID}
				runId="00000000-0000-4000-8000-0000000000c3"
				status="RUNNING"
				hasEncoding
				plan={rtmpPlan}
			/>,
		);
		await userEvent.click(
			await screen.findByText("RTMP ingest points", { selector: "summary" }),
		);
		expect(screen.getByRole("checkbox", { name: "primary" })).toBeChecked();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
	const render = (status: "RUNNING" | "STOPPED" | "ERROR" | "CREATED") =>
		wrap(
			<ChannelLifecycleActions
				channelId={CHANNEL_ID}
				status={status}
				hasEncoding
			/>,
		);

	it("does NOT offer restart on a STOPPED channel — its encoding is FINISHED", () => {
		// The defect an operator hit on 2026-08-16: the button was there, and
		// Bitmovin answered 409 code 2028 ("not possible in its current state
		// 'FINISHED'"). stopChannel calls stopLiveEncoding, so STOPPED implies
		// a terminal encoding whose infrastructure is deallocated — restart
		// cannot succeed, ever, and offering it is a false affordance.
		const view = render("STOPPED");
		expect(
			screen.queryByRole("button", {
				name: /チャンネルを再起動|Restart channel/i,
			}),
		).toBeNull();
		view.unmount();
	});

	it("DOES offer restart while RUNNING or in ERROR — where the encoder may still be up", () => {
		for (const status of ["RUNNING", "ERROR"] as const) {
			const view = render(status);
			expect(
				screen.getByRole("button", {
					name: /チャンネルを再起動|Restart channel/i,
				}),
				status,
			).toBeInTheDocument();
			view.unmount();
		}
	});

	/* Lifecycle buttons describe channel operations; provider encoder details remain secondary. */
	it("labels start and stop as CHANNEL operations in both locales", () => {
		for (const [locale, start, stop] of [
			["en", "Start channel", "Stop channel"],
			["ja", "チャンネルを開始", "チャンネルを停止"],
		] as const) {
			const created = wrap(
				<ChannelLifecycleActions
					channelId={CHANNEL_ID}
					status="CREATED"
					hasEncoding={false}
				/>,
				locale,
			);
			expect(screen.getByRole("button", { name: start })).toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: /エンコーダ|encoder/i }),
				locale,
			).toBeNull();
			created.unmount();
			const running = wrap(
				<ChannelLifecycleActions
					channelId={CHANNEL_ID}
					status="RUNNING"
					hasEncoding
				/>,
				locale,
			);
			expect(screen.getByRole("button", { name: stop })).toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: /エンコーダ|encoder/i }),
				locale,
			).toBeNull();
			running.unmount();
		}
	});

	/**
	 * The lifecycle row carries neither Duplicate nor Delete. It is the
	 * header control, and a Delete beside Stop in a fixed
	 * header creates an avoidable mis-click risk.
	 * Duplicate is the recovery for a stopped channel and still exists — one
	 * layer down, in Advanced.
	 */
	it("carries neither copy-settings nor delete inside the lifecycle control", () => {
		render("STOPPED");
		expect(
			screen.queryByRole("button", {
				name: /設定をコピーして編集|Copy settings and edit/i,
			}),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: /Delete channel/i }),
		).toBeNull();
	});
});

describe("DuplicateChannelButton", () => {
	it("still offers the real recovery for a stopped channel, and routes to the wizard", async () => {
		wrap(<DuplicateChannelButton channelId={CHANNEL_ID} />);
		await userEvent.click(
			await screen.findByRole("button", {
				name: /設定をコピーして編集|Copy settings and edit/i,
			}),
		);
		expect(routerPush).toHaveBeenCalledWith(`/live/new?from=${CHANNEL_ID}`);
	});
});

describe("ChannelCueForm request identity", () => {
	it("reuses the request ID after failure and rotates it only after success", async () => {
		let cueCalls = 0;
		apiFetch.mockImplementation(async (input: string) => {
			if (input === "/api/auth/session") {
				return {
					mode: "password",
					configured: true,
					authenticated: true,
					loginKind: "password-form",
				};
			}
			cueCalls += 1;
			if (cueCalls === 1) throw new Error("response lost");
			return { acknowledged: true };
		});
		wrap(
			<ChannelCueForm
				channelId={CHANNEL_ID}
				status="RUNNING"
				stepEntries={[]}
			/>,
		);
		const button = await screen.findByRole("button", {
			name: /Insert cue|キューを挿入/i,
		});
		const user = userEvent.setup();

		await user.click(button);
		await waitFor(() => expect(cueCalls).toBe(1));
		await user.click(button);
		await waitFor(() => expect(cueCalls).toBe(2));
		await user.click(button);
		await waitFor(() => expect(cueCalls).toBe(3));

		const bodies = apiFetch.mock.calls
			.filter(([url]) => String(url).endsWith("/actions"))
			.map(([, init]) => JSON.parse(String((init as RequestInit).body)));
		expect(bodies[0].requestId).toBe(bodies[1].requestId);
		expect(bodies[2].requestId).not.toBe(bodies[1].requestId);
	});
});

describe("startup cancellation controls", () => {
	it("keeps Cancel enabled while Start response is pending, then binds its generation", async () => {
		let finishStart!: (value: unknown) => void;
		const pending = new Promise((resolve) => {
			finishStart = resolve;
		});
		apiFetch.mockImplementation(async (url: string, options?: RequestInit) => {
			if (url === "/api/auth/session")
				return {
					mode: "password",
					configured: true,
					authenticated: true,
					loginKind: "password-form",
				};
			if (!options) return { liveEffectFenceVersion: 5 };
			const body = JSON.parse(String(options.body));
			if (body.action === "start") return pending;
			return { status: "STOPPING", cancellationRequested: true };
		});
		wrap(
			<ChannelLifecycleActions
				channelId={CHANNEL_ID}
				status="STOPPED"
				hasEncoding
				generation={4}
				runId={RUN_ID}
			/>,
		);
		await userEvent.click(
			screen.getByRole("button", { name: "Start a new run" }),
		);
		const cancel = await screen.findByRole("button", { name: "Cancel start" });
		expect(cancel).toBeEnabled();
		await userEvent.click(cancel);
		await waitFor(() =>
			expect(
				apiFetch.mock.calls.some(
					(c) =>
						c[1] &&
						JSON.parse(String((c[1] as RequestInit).body)).action ===
							"cancel-start",
				),
			).toBe(true),
		);
		const call = apiFetch.mock.calls.find(
			(c) =>
				c[1] &&
				JSON.parse(String((c[1] as RequestInit).body)).action ===
					"cancel-start",
		);
		if (!call) throw new Error("Expected cancel request");
		expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({
			action: "cancel-start",
			generation: 5,
		});
		finishStart({ status: "PROVISIONING" });
		await screen.findByText("Start cancellation requested.");
	});
	it("shows cancellation in progress from durable server state without claiming stopped", () => {
		wrap(
			<ChannelLifecycleActions
				channelId={CHANNEL_ID}
				status="PROVISIONING"
				hasEncoding={false}
				cancelRequested
				generation={5}
				runId={RUN_ID}
			/>,
		);
		expect(
			screen.getByRole("button", { name: "Cancelling start" }),
		).toBeDisabled();
		expect(
			screen.queryByRole("button", { name: "Start channel" }),
		).not.toBeInTheDocument();
	});
});

describe("startup cancellation generation and failure recovery", () => {
	it("does not send a delayed cancel to a newer generation", async () => {
		let finish!: (value: unknown) => void;
		apiFetch.mockImplementation(async (url: string, options?: RequestInit) => {
			if (url === "/api/auth/session")
				return {
					mode: "password",
					configured: true,
					authenticated: true,
					loginKind: "password-form",
				};
			if (!options) return { liveEffectFenceVersion: 6 };
			if (JSON.parse(String(options.body)).action === "start")
				return new Promise((resolve) => {
					finish = resolve;
				});
			throw new Error("Unexpected cancel POST");
		});
		wrap(
			<ChannelLifecycleActions
				channelId={CHANNEL_ID}
				status="STOPPED"
				hasEncoding
				generation={4}
				runId={RUN_ID}
			/>,
		);
		await userEvent.click(
			screen.getByRole("button", { name: "Start a new run" }),
		);
		await userEvent.click(
			await screen.findByRole("button", { name: "Cancel start" }),
		);
		await screen.findByRole("alert");
		expect(
			apiFetch.mock.calls.filter(
				(c) => c[1] && JSON.parse(String(c[1].body)).action === "cancel-start",
			),
		).toHaveLength(0);
		finish({ status: "PROVISIONING" });
	});
	it("restores Start after both Start and cancellation fail without a server claim", async () => {
		let fail!: (error: Error) => void;
		let reads = 0;
		apiFetch.mockImplementation(async (url: string, options?: RequestInit) => {
			if (url === "/api/auth/session")
				return {
					mode: "password",
					configured: true,
					authenticated: true,
					loginKind: "password-form",
				};
			if (!options) {
				if (++reads === 1) throw new Error("GET temporarily unavailable");
				return { liveEffectFenceVersion: 4 };
			}
			if (JSON.parse(String(options.body)).action === "start")
				return new Promise((_resolve, reject) => {
					fail = reject;
				});
			throw new Error("Unexpected cancel POST");
		});
		wrap(
			<ChannelLifecycleActions
				channelId={CHANNEL_ID}
				status="STOPPED"
				hasEncoding
				generation={4}
				runId={RUN_ID}
			/>,
		);
		await userEvent.click(
			screen.getByRole("button", { name: "Start a new run" }),
		);
		await userEvent.click(
			await screen.findByRole("button", { name: "Cancel start" }),
		);
		await screen.findByRole("alert");
		fail(new Error("START rejected before claim"));
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Start a new run" }),
			).toBeEnabled(),
		);
		expect(
			screen.queryByRole("button", { name: "Cancelling start" }),
		).not.toBeInTheDocument();
	});
	it("does not mislabel an ordinary STOPPING run as a startup cancellation", () => {
		wrap(
			<ChannelLifecycleActions
				channelId={CHANNEL_ID}
				status="STOPPING"
				hasEncoding
				generation={4}
				runId={RUN_ID}
			/>,
		);
		expect(
			screen.queryByRole("button", { name: "Cancelling start" }),
		).not.toBeInTheDocument();
	});
});

describe("cancellation projection belongs to one run", () => {
	it.each([
		4, 5,
	])("restores lifecycle actions after another operator advances the run (generation=%s)", async (nextGeneration) => {
		apiFetch.mockImplementation(async (url: string) =>
			url === "/api/auth/session"
				? {
						mode: "password",
						configured: true,
						authenticated: true,
						loginKind: "password-form",
					}
				: { runId: RUN_ID, status: "STOPPING", cancellationRequested: true },
		);
		const view = wrap(
			<ChannelLifecycleActions
				channelId={CHANNEL_ID}
				status="PROVISIONING"
				hasEncoding
				generation={4}
				runId={RUN_ID}
			/>,
		);
		await userEvent.click(screen.getByRole("button", { name: "Cancel start" }));
		await screen.findByText("Start cancellation requested.");
		view.rerender(
			<ChannelLifecycleActions
				channelId={CHANNEL_ID}
				status="RUNNING"
				hasEncoding
				generation={nextGeneration}
				runId="00000000-0000-4000-8000-0000000000c3"
			/>,
		);
		expect(screen.getByRole("button", { name: "Stop channel" })).toBeEnabled();
		expect(
			screen.getByRole("button", { name: "Restart channel" }),
		).toBeEnabled();
		expect(
			screen.queryByRole("button", { name: "Cancelling start" }),
		).not.toBeInTheDocument();
	});
	it("does not let a late cancellation response hide controls for the next run", async () => {
		let finish!: (value: unknown) => void;
		apiFetch.mockImplementation(async (url: string) =>
			url === "/api/auth/session"
				? {
						mode: "password",
						configured: true,
						authenticated: true,
						loginKind: "password-form",
					}
				: new Promise((resolve) => {
						finish = resolve;
					}),
		);
		const view = wrap(
			<ChannelLifecycleActions
				channelId={CHANNEL_ID}
				status="PROVISIONING"
				hasEncoding
				generation={4}
				runId={RUN_ID}
			/>,
		);
		await userEvent.click(screen.getByRole("button", { name: "Cancel start" }));
		view.rerender(
			<ChannelLifecycleActions
				channelId={CHANNEL_ID}
				status="RUNNING"
				hasEncoding
				generation={5}
				runId="00000000-0000-4000-8000-0000000000c3"
			/>,
		);
		expect(screen.getByRole("button", { name: "Stop channel" })).toBeEnabled();
		finish({ runId: RUN_ID, status: "STOPPING", cancellationRequested: true });
		await waitFor(() =>
			expect(
				screen.queryByRole("button", { name: "Cancelling start" }),
			).not.toBeInTheDocument(),
		);
		expect(screen.getByRole("button", { name: "Stop channel" })).toBeEnabled();
	});
});
