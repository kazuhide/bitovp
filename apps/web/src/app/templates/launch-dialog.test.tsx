import {
	type EncodingPlan,
	encodingPlanSchema,
	templateSourceSites,
} from "@bitovp/core";
import { samplePresetPlan } from "@bitovp/core/presets";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { LaunchDialog } from "./launch-dialog";

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
	vi.useRealTimers();
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

function detailFor(body: unknown) {
	return {
		id: ID,
		name: "hardened-hls",
		body,
		launchDefaults: null,
		revision: 3,
	};
}

describe("LaunchDialog (ledger #109 §4.1)", () => {
	it("keeps unstructured provider diagnostics out of the creation error", async () => {
		apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
			if (url === `/api/presets/${ID}`)
				return detailFor(samplePresetPlan("fixed-bitrate-hls-on-aws"));
			if (init?.method === "POST")
				throw new Error("PRIVATE_PROVIDER_DIAGNOSTIC");
			return [];
		});
		renderWithQuery(<LaunchDialog presetId={ID} onClose={() => {}} />);
		await screen.findByLabelText(/Job name/i);
		const submit = screen.getByRole("button", { name: /Create job/i });
		fireEvent.click(submit);
		await waitFor(() =>
			expect(
				apiFetch.mock.calls.some(([, init]) => init?.method === "POST"),
			).toBe(true),
		);
		await waitFor(() => expect(submit).toBeEnabled());
		expect(screen.queryByText(/PRIVATE_PROVIDER_DIAGNOSTIC/)).toBeNull();
		expect(screen.getByText("Create failed")).toBeInTheDocument();
	});
	it.each([
		"sparse source",
		"UUID name",
		"midnight",
	])("retains visible values and creation identity after remount with %s", async (mode) => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2030-01-01T23:59:59Z"));
		const body = samplePresetPlan("fixed-bitrate-hls-on-aws");
		apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
			if (url === `/api/presets/${ID}`)
				return {
					...detailFor(body),
					launchDefaults:
						mode === "UUID name"
							? { nameTemplate: "{template} {date} {uuid}" }
							: null,
				};
			if (url === "/api/encoding-jobs" && init?.method === "POST")
				throw new Error("response lost");
			return [];
		});
		const view = renderWithQuery(
			<LaunchDialog presetId={ID} onClose={() => {}} />,
		);
		const firstName = (await screen.findByLabelText(
			/Job name/i,
		)) as HTMLInputElement;
		await waitFor(() => expect(firstName.value).not.toBe(""));
		const visibleName = firstName.value;
		if (mode === "sparse source") {
			const site = templateSourceSites(encodingPlanSchema.parse(body))[0];
			if (!site) throw new Error("missing source");
			const field = screen.getByLabelText(site.siteId);
			fireEvent.change(field, { target: { value: "temporary.mp4" } });
			fireEvent.change(field, { target: { value: site.currentPath } });
		}
		fireEvent.click(screen.getByRole("button", { name: /Create job/i }));
		await screen.findByText("Create failed");
		view.unmount();
		if (mode === "midnight") vi.setSystemTime(new Date("2030-01-02T00:00:01Z"));
		renderWithQuery(<LaunchDialog presetId={ID} onClose={() => {}} />);
		const restoredName = await screen.findByLabelText(/Job name/i);
		await waitFor(() => expect(restoredName).toHaveValue(visibleName));
		fireEvent.click(screen.getByRole("button", { name: /Create job/i }));
		await waitFor(() =>
			expect(
				apiFetch.mock.calls.filter(([url]) => url === "/api/encoding-jobs"),
			).toHaveLength(2),
		);
		const posts = apiFetch.mock.calls.filter(
			([url]) => url === "/api/encoding-jobs",
		);
		expect(new Headers(posts[1]?.[1].headers).get("Idempotency-Key")).toBe(
			new Headers(posts[0]?.[1].headers).get("Idempotency-Key"),
		);
		expect(posts[1]?.[1].body).toBe(posts[0]?.[1].body);
	});
	it("retries a lost response with the same creation key and rendered output prefix", async () => {
		const body = samplePresetPlan("fixed-bitrate-hls-on-aws");
		let attempts = 0;
		apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
			if (url === `/api/presets/${ID}`) return detailFor(body);
			if (url === "/api/encoding-jobs" && init?.method === "POST") {
				if (++attempts === 1) throw new Error("response lost");
				return { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5" };
			}
			return [];
		});
		const view = renderWithQuery(
			<LaunchDialog presetId={ID} onClose={() => {}} />,
		);
		await screen.findByLabelText(/Job name/i);
		fireEvent.click(screen.getByRole("button", { name: /Create job/i }));
		await screen.findByText("Create failed");
		view.unmount();
		renderWithQuery(<LaunchDialog presetId={ID} onClose={() => {}} />);
		await screen.findByLabelText(/Job name/i);
		fireEvent.click(screen.getByRole("button", { name: /Create job/i }));
		await waitFor(() =>
			expect(routerPush).toHaveBeenCalledWith(
				"/vod/jobs/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5",
			),
		);
		const posts = apiFetch.mock.calls.filter(
			([url]) => url === "/api/encoding-jobs",
		);
		expect(posts).toHaveLength(2);
		const requestKey = new Headers(posts[0]?.[1].headers).get(
			"Idempotency-Key",
		);
		expect(requestKey).toMatch(/^[a-f0-9]{64}$/);
		expect(new Headers(posts[1]?.[1].headers).get("Idempotency-Key")).toBe(
			requestKey,
		);
		expect(posts[1]?.[1].body).toBe(posts[0]?.[1].body);
	});
	it("derives one prefilled source row per site — the ask-list is the plan's, never authored", async () => {
		const body = samplePresetPlan("fixed-bitrate-hls-on-aws");
		apiFetch.mockImplementation(async (url: string) => {
			if (url === `/api/presets/${ID}`) {
				return detailFor(body);
			}
			throw new Error(`unexpected ${url}`);
		});
		renderWithQuery(<LaunchDialog presetId={ID} onClose={() => {}} />);

		const sites = templateSourceSites(
			encodingPlanSchema.parse(body) as EncodingPlan,
		);
		expect(sites.length).toBeGreaterThanOrEqual(1);
		for (const site of sites) {
			const input = (await screen.findByLabelText(
				site.siteId,
			)) as HTMLInputElement;
			expect(input.value).toBe(site.currentPath);
		}
	});

	it("creates the job with the INSTANTIATED plan + provenance, then navigates", async () => {
		const body = samplePresetPlan("fixed-bitrate-hls-on-aws");
		apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
			if (url === `/api/presets/${ID}`) {
				return detailFor(body);
			}
			if (url === "/api/encoding-jobs" && init?.method === "POST") {
				return { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee6" };
			}
			throw new Error(`unexpected ${url}`);
		});
		renderWithQuery(<LaunchDialog presetId={ID} onClose={() => {}} />);

		// The name field seeds from {template} {date} — non-empty enables Create.
		const name = (await screen.findByLabelText(
			/Job name/i,
		)) as HTMLInputElement;
		expect(name.value).toMatch(/^hardened-hls \d{4}-\d{2}-\d{2}$/);

		fireEvent.click(screen.getByRole("button", { name: /Create job/i }));
		await waitFor(() => {
			expect(routerPush).toHaveBeenCalledWith(
				"/vod/jobs/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee6",
			);
		});
		const post = apiFetch.mock.calls.find(
			([url]) => url === "/api/encoding-jobs",
		);
		if (!post) {
			throw new Error("POST never fired");
		}
		const payload = JSON.parse((post[1] as RequestInit).body as string) as {
			plan: unknown;
			presetId: string;
			presetRevision: number;
		};
		// Provenance rides the create (the loaded revision, not a re-read).
		expect(payload.presetId).toBe(ID);
		expect(payload.presetRevision).toBe(3);
		// The plan is the INSTANTIATION: re-parses, and every destination sits
		// under the rendered {template}/{date}-{uuid} prefix — not the
		// template's own paths (the #87 overwrite rule).
		const plan = encodingPlanSchema.parse(payload.plan);
		const walk = (node: unknown, out: string[]): string[] => {
			if (Array.isArray(node)) {
				for (const item of node) {
					walk(item, out);
				}
			} else if (node && typeof node === "object") {
				const rec = node as Record<string, unknown>;
				if (typeof rec.outputKey === "string" && typeof rec.path === "string") {
					out.push(rec.path);
				}
				for (const v of Object.values(rec)) {
					walk(v, out);
				}
			}
			return out;
		};
		const destinations = walk(plan, []);
		expect(destinations.length).toBeGreaterThan(0);
		for (const path of destinations) {
			expect(path).toMatch(/^hardened-hls\/\d{4}-\d{2}-\d{2}-/);
		}
	});

	it("shows a named refusal instead of posting when the prefix renders empty", async () => {
		const body = samplePresetPlan("fixed-bitrate-hls-on-aws");
		apiFetch.mockImplementation(async (url: string) => {
			if (url === `/api/presets/${ID}`) {
				return detailFor(body);
			}
			throw new Error(`unexpected ${url}`);
		});
		renderWithQuery(<LaunchDialog presetId={ID} onClose={() => {}} />);

		const prefix = (await screen.findByLabelText(
			/Output prefix/i,
		)) as HTMLInputElement;
		// {ext} of an extension-bearing source is non-empty; force EMPTY by
		// clearing the template to a token that renders to nothing: "{rule}"
		// is not a launch token and renders verbatim — instead use a template
		// that is only slashes after token substitution.
		fireEvent.change(prefix, { target: { value: "/" } });
		fireEvent.click(screen.getByRole("button", { name: /Create job/i }));
		expect(
			await screen.findByText(/rendered EMPTY|overwrite/i),
		).toBeInTheDocument();
		expect(
			apiFetch.mock.calls.find(([url]) => url === "/api/encoding-jobs"),
		).toBeUndefined();
	});
});
