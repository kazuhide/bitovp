import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { LiveLaunchDialog } from "./live-launch-dialog";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async () => {
	const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
	return {
		ApiError: actual.ApiError,
		apiFetch: (...args: unknown[]) => apiFetch(...args),
	};
});

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: routerPush }),
}));

afterEach(() => {
	apiFetch.mockReset();
	routerPush.mockReset();
});

const ID = "11111111-2222-4333-8444-555555555555";
beforeEach(() => sessionStorage.clear());
vi.mock("@/lib/auth/use-session", async (original) => ({
	...(await original<Record<string, unknown>>()),
	useSession: () => ({
		status: "success",
		isFetchedAfterMount: true,
		isFetching: false,
		data: {
			configured: true,
			authenticated: true,
			mode: "users",
			role: "OPERATOR",
			organizationId: "org",
			effectiveUserId: "user",
		},
	}),
}));
const LIVE_BODY = JSON.parse(
	readFileSync(
		join(
			__dirname,
			"../../../../../packages/core/src/live/__fixtures__/live-zixi.plan.json",
		),
		"utf8",
	),
) as Record<string, unknown>;

function collectDestinations(node: unknown, out: string[] = []): string[] {
	if (Array.isArray(node)) {
		for (const item of node) {
			collectDestinations(item, out);
		}
	} else if (node && typeof node === "object") {
		const rec = node as Record<string, unknown>;
		if (typeof rec.outputKey === "string" && typeof rec.path === "string") {
			out.push(rec.path);
		}
		for (const v of Object.values(rec)) {
			collectDestinations(v, out);
		}
	}
	return out;
}

describe("LiveLaunchDialog (ledger #109 §4.2)", () => {
	it("retries a lost response with the same key and output paths, and changes both after editing", async () => {
		apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
			if (url === `/api/presets/${ID}`)
				return { id: ID, name: "eve-show", body: LIVE_BODY, revision: 2 };
			if (url === "/api/live-channels" && init?.method === "POST")
				throw new Error("response lost");
			return [];
		});
		renderWithQuery(<LiveLaunchDialog presetId={ID} onClose={() => {}} />);
		const name = await screen.findByLabelText(/Channel name/i);
		const submit = screen.getByRole("button", { name: /Create channel/i });
		fireEvent.click(submit);
		await screen.findByText(/response lost/);
		fireEvent.click(submit);
		await waitFor(() =>
			expect(
				apiFetch.mock.calls.filter(([url]) => url === "/api/live-channels"),
			).toHaveLength(2),
		);
		await waitFor(() => expect(submit).toBeEnabled());
		fireEvent.change(name, { target: { value: "Edited launch" } });
		fireEvent.click(submit);
		await waitFor(() =>
			expect(
				apiFetch.mock.calls.filter(([url]) => url === "/api/live-channels"),
			).toHaveLength(3),
		);
		const posts = apiFetch.mock.calls.filter(
			([url]) => url === "/api/live-channels",
		);
		const requestKey = new Headers(posts[0]?.[1].headers).get(
			"Idempotency-Key",
		);
		expect(requestKey).toMatch(/^[a-f0-9]{64}$/);
		expect(new Headers(posts[1]?.[1].headers).get("Idempotency-Key")).toBe(
			requestKey,
		);
		expect(posts[1]?.[1].body).toBe(posts[0]?.[1].body);
		expect(new Headers(posts[2]?.[1].headers).get("Idempotency-Key")).not.toBe(
			requestKey,
		);
		expect(
			collectDestinations(JSON.parse(posts[2]?.[1].body).plan),
		).not.toEqual(collectDestinations(JSON.parse(posts[0]?.[1].body).plan));
	});
	it("asks only name + schedule; creates the RENAMED plan with provenance (no schedule = none posted)", async () => {
		apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
			if (url === `/api/presets/${ID}`) {
				return { id: ID, name: "eve-show", body: LIVE_BODY, revision: 2 };
			}
			if (url === "/api/live-channels" && init?.method === "POST") {
				return { id: "ch-1" };
			}
			return [];
		});
		renderWithQuery(<LiveLaunchDialog presetId={ID} onClose={() => {}} />);

		const name = (await screen.findByLabelText(
			/Channel name/i,
		)) as HTMLInputElement;
		expect(name.value).toMatch(/^eve-show \d{4}-\d{2}-\d{2}$/);
		// A live template asks for NO source rows — ingest is push .
		expect(screen.queryByText(/Sources/)).not.toBeInTheDocument();

		fireEvent.change(name, { target: { value: "friday-show" } });
		fireEvent.click(screen.getByRole("button", { name: /Create channel/i }));
		await waitFor(() => {
			expect(routerPush).toHaveBeenCalledWith("/live/ch-1");
		});
		const post = apiFetch.mock.calls.find(
			([url]) => url === "/api/live-channels",
		);
		if (!post) {
			throw new Error("POST never fired");
		}
		const payload = JSON.parse((post[1] as RequestInit).body as string) as {
			plan: { name: string };
			schedule?: unknown;
			presetId: string;
			presetRevision: number;
		};
		expect(payload.plan.name).toBe("friday-show");
		expect(payload.schedule).toBeUndefined();
		expect(payload.presetId).toBe(ID);
		expect(payload.presetRevision).toBe(2);
		// review-109pr1 L1: the posted plan is the REBASE, not the template's
		// own destinations — every destination sits under the per-launch
		// {template}/{date}-{uuid} prefix.
		const destinations = collectDestinations(payload.plan);
		expect(destinations.length).toBeGreaterThan(0);
		for (const path of destinations) {
			expect(path).toMatch(/^eve-show\/\d{4}-\d{2}-\d{2}-[0-9a-f]{32}\//);
		}
	});

	it("two launches of ONE template share ZERO output paths (design §4.2/§8 — review-109pr1 L1, Critical)", async () => {
		const payloads: Array<{ plan: unknown }> = [];
		apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
			if (url === `/api/presets/${ID}`) {
				return { id: ID, name: "eve-show", body: LIVE_BODY, revision: 2 };
			}
			if (url === "/api/live-channels" && init?.method === "POST") {
				payloads.push(JSON.parse(init.body as string));
				return { id: `ch-${payloads.length}` };
			}
			return [];
		});
		for (let i = 0; i < 2; i += 1) {
			const view = renderWithQuery(
				<LiveLaunchDialog presetId={ID} onClose={() => {}} />,
			);
			await screen.findByLabelText(/Channel name/i);
			fireEvent.click(screen.getByRole("button", { name: /Create channel/i }));
			await waitFor(() => {
				expect(payloads.length).toBe(i + 1);
			});
			view.unmount();
		}
		const first = new Set(collectDestinations(payloads[0]?.plan));
		const second = collectDestinations(payloads[1]?.plan);
		expect(first.size).toBeGreaterThan(0);
		expect(second.length).toBeGreaterThan(0);
		// The whole point of a channel template is launching it twice — the
		// first cut wrote both channels at the template's own paths.
		for (const path of second) {
			expect(first.has(path)).toBe(false);
		}
	});

	it("refuses a body that is not a live plan", async () => {
		apiFetch.mockImplementation(async (url: string) => {
			if (url === `/api/presets/${ID}`) {
				return {
					id: ID,
					name: "vod-thing",
					body: { planVersion: 1 },
					revision: 1,
				};
			}
			return [];
		});
		renderWithQuery(<LiveLaunchDialog presetId={ID} onClose={() => {}} />);
		expect(
			await screen.findByText(/not a valid live channel plan/i),
		).toBeInTheDocument();
	});
});
