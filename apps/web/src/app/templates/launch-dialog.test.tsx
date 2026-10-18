import {
	type EncodingPlan,
	encodingPlanSchema,
	templateSourceSites,
} from "@bitovp/core";
import { samplePresetPlan } from "@bitovp/core/presets";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});

const ID = "11111111-2222-4333-8444-555555555555";

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
				return { id: "job-1" };
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
			expect(routerPush).toHaveBeenCalledWith("/vod/jobs/job-1");
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
