import { DELIVERY_SPECS } from "@bitovp/core";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery as wrap } from "@/test/render";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
// The wizard calls useRouter for replace/push.
const replace = vi.fn();
vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace, push: vi.fn() }),
}));

import { VodWizard } from "./wizard";

/**
 * Delivery-spec drift banner : loading a delivery preset retains
 * its constraints, and the CURRENT form plan is checked against them on every
 * render — the operator who edits away from spec is told, with the table, and
 * may dismiss (drift is legitimate; silence about it is the failure mode).
 */

const firstSpec = DELIVERY_SPECS[0];
if (!firstSpec) {
	throw new Error("no shipped delivery specs");
}
// Re-bound so the narrowing survives into closures (TS18048 otherwise).
const spec: (typeof DELIVERY_SPECS)[number] = firstSpec;

function mockApi(plan: unknown) {
	apiFetch.mockImplementation(async (input: string) => {
		if (input.startsWith("/api/delivery-presets/")) {
			return {
				// `id` included because the REAL route returns the whole
				// DeliverySpec — the first mock omitted it, the commitment
				// select correctly hid itself (no submit-gate-valid id, no
				// commitment), and the test read that as the strip being broken.
				spec: {
					id: spec.id,
					name: spec.name,
					plan,
					constraints: spec.constraints,
				},
			};
		}
		if (input === "/api/credentials") {
			return [];
		}
		if (input === "/api/bitmovin-accounts") {
			return [];
		}
		throw new Error(`unexpected fetch ${input}`);
	});
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("delivery drift banner", () => {
	it("a self-conforming load shows NO banner (zero deviations)", async () => {
		mockApi(spec.plan);
		wrap(<VodWizard deliveryPresetId={spec.id} />, "ja");
		await waitFor(() => {
			expect(
				apiFetch.mock.calls.some((c) =>
					String(c[0]).startsWith("/api/delivery-presets/"),
				),
			).toBe(true);
		});
		await waitFor(() => {
			expect(screen.queryByText(/件逸脱しています/)).toBeNull();
		});
	});

	it("a deviating plan under the same spec shows the count, the table, and dismiss", async () => {
		// The spec's own plan with the video bitrate dropped below the window:
		// exactly what an operator editing away from spec produces.
		const deviating = JSON.parse(JSON.stringify(spec.plan)) as {
			renditions: { bitrate: number | null }[];
		};
		const first = deviating.renditions[0];
		if (!first) {
			throw new Error("no renditions");
		}
		first.bitrate = 30_000_000;
		mockApi(deviating);
		wrap(<VodWizard deliveryPresetId={spec.id} />, "ja");
		const banner = await screen.findByText(/1 件逸脱しています/);
		expect(banner.textContent).toContain(spec.name);
		// Expand: the deviation row names the requirement and the found value.
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "逸脱を表示" }));
		expect(screen.getByText(/Video bitrate 45–55 Mbps/)).toBeInTheDocument();
		expect(screen.getByText("30000000")).toBeInTheDocument();
		// Dismiss stops tracking entirely.
		await user.click(screen.getByRole("button", { name: "閉じる" }));
		expect(screen.queryByText(/件逸脱しています/)).toBeNull();
	});
});

/**
 * review-205 I5: the two behaviors the ledger asserts that ZERO tests
 * watched — both of the reviewer's mutations survived 2,237 tests.
 */
describe("drift sources (review-205 I5)", () => {
	it("drift judges the IMPORTED RAW plan once one is loaded, not the mapped form", async () => {
		// Load the self-conforming spec (form path, no banner), then paste a
		// DEVIATING verbatim plan into the import box. The killed mutation —
		// `imported ? imported.raw : buildPlan(state)` → `buildPlan(state)` —
		// keeps judging the conforming form and shows nothing.
		mockApi(spec.plan);
		wrap(<VodWizard deliveryPresetId={spec.id} />, "ja");
		await waitFor(() => {
			expect(screen.queryByText(/件逸脱しています/)).toBeNull();
		});
		const deviating = JSON.parse(JSON.stringify(spec.plan)) as {
			renditions: { bitrate: number | null }[];
		};
		const first = deviating.renditions[0];
		if (!first) {
			throw new Error("no renditions");
		}
		first.bitrate = 30_000_000;
		const user = userEvent.setup();
		await user.click(
			await screen.findByRole("button", { name: "プラン JSON をインポート…" }),
		);
		const importBox = screen
			.getAllByRole("textbox")
			.find((el) => el.tagName === "TEXTAREA");
		if (!importBox) {
			throw new Error("import textarea not rendered");
		}
		await user.click(importBox);
		await user.paste(JSON.stringify(deviating));
		await user.click(screen.getByRole("button", { name: "検証して読み込む" }));
		expect(await screen.findByText(/1 件逸脱しています/)).toBeInTheDocument();
	});

	it("a SAVED user preset carrying a spec re-arms the banner on load", async () => {
		// The ledger's sentence; the reviewer deleted the whole userPresetId
		// branch of loadedSpec and 2,237 tests stayed green.
		const deviating = JSON.parse(JSON.stringify(spec.plan)) as {
			renditions: { bitrate: number | null }[];
		};
		const first = deviating.renditions[0];
		if (!first) {
			throw new Error("no renditions");
		}
		first.bitrate = 30_000_000;
		apiFetch.mockImplementation(async (input: string) => {
			if (input.startsWith("/api/presets/")) {
				return {
					id: "00000000-0000-4000-8000-0000000000a9",
					name: "Org saved mezz",
					body: deviating,
					spec: { constraints: spec.constraints },
				};
			}
			if (input === "/api/credentials" || input === "/api/bitmovin-accounts") {
				return [];
			}
			throw new Error(`unexpected fetch ${input}`);
		});
		wrap(
			<VodWizard userPresetId="00000000-0000-4000-8000-0000000000a9" />,
			"ja",
		);
		const banner = await screen.findByText(/1 件逸脱しています/);
		expect(banner.textContent).toContain("Org saved mezz");
	});
});

describe("the delivery COMMITMENT select (ledger #149 — #82's last unreachable field)", () => {
	/**
	 * `state.delivery` and its round-trip landed with #82; no form ever wrote
	 * it, so WARN/REFUSE were reachable only by hand-editing plan JSON. The
	 * select's `value` is read straight off `state.delivery?.onDeviation`, so
	 * asserting the value AFTER selecting proves the patch landed in wizard
	 * state, not in some local mirror.
	 */
	it("commits REFUSE into wizard state, and dismiss clears it", async () => {
		// SELF-CONFORMING on purpose: the strip must render with ZERO
		// deviations, because committing to a spec you currently satisfy is
		// exactly when REFUSE is cheap to adopt. (And the first draft forgot
		// mockApi entirely — no spec ever loaded, nothing rendered.)
		mockApi(spec.plan);
		wrap(<VodWizard deliveryPresetId={spec.id} />, "ja");
		// Wait on the strip's TEXT first — findByLabelText's error swallows the
		// "did the strip render at all" question.
		await screen.findByText(/配信仕様:/);
		const select = (await screen.findByLabelText(/適合の扱い/)) as
			| HTMLSelectElement
			| HTMLElement;
		if (!(select instanceof HTMLSelectElement)) {
			throw new Error("commitment control is not a select");
		}
		expect(select.value).toBe(""); // banner-only default: no behaviour change
		expect([...select.options].map((o) => o.value)).toEqual([
			"",
			"WARN",
			"REFUSE",
		]);
		await userEvent.selectOptions(select, "REFUSE");
		expect(select.value).toBe("REFUSE");
	});

	it("dismiss clears the commitment FROM THE PLAN, not just from the screen", async () => {
		/*
		 * The first draft asserted the select's absence behind `if (dismiss)` —
		 * a guard that never ran (self-conforming spec, no banner, no dismiss
		 * button), which a survived mutation exposed: removing the dismiss
		 * handler's `patch({ delivery: undefined })` left the test green. And
		 * the select's absence would not have proven the state cleared anyway:
		 * the strip unmounts because driftSpec is null, so a stale
		 * `state.delivery` would keep refusing submissions INVISIBLY — the
		 * exact failure dismissing must rule out. So this test reads the
		 * compiled plan through the preview, where `buildPlan` emits
		 * `state.delivery` (core build-plan.ts) for submit.ts to enforce.
		 */
		const deviating = JSON.parse(JSON.stringify(spec.plan)) as {
			renditions: { bitrate: number | null }[];
			inputs?: { credentialId?: string }[];
			outputs?: { credentialId?: string }[];
		};
		const first = deviating.renditions[0];
		if (!first) {
			throw new Error("no renditions");
		}
		first.bitrate = 30_000_000;
		// Specs ship credential-free, so the mapped form is INCOMPLETE and the
		// preview shows "fill the required fields" instead of a document. Stand
		// in for the operator's credential picks so plan JSON can render.
		const cred = "11111111-1111-4111-8111-111111111111";
		for (const i of deviating.inputs ?? []) i.credentialId = cred;
		for (const o of deviating.outputs ?? []) o.credentialId = cred;
		mockApi(deviating);
		wrap(<VodWizard deliveryPresetId={spec.id} />, "ja");
		await screen.findByText(/1 件逸脱しています/);

		const select = (await screen.findByLabelText(/適合の扱い/)) as
			| HTMLSelectElement
			| HTMLElement;
		if (!(select instanceof HTMLSelectElement)) {
			throw new Error("commitment control is not a select");
		}
		await userEvent.selectOptions(select, "REFUSE");

		// Presence FIRST: absence-after-dismiss proves nothing unless the
		// commitment demonstrably reached the plan while committed.
		await userEvent.click(screen.getByRole("button", { name: "プラン JSON" }));
		expect(screen.getByTestId("plan-json").textContent).toContain(
			'"onDeviation": "REFUSE"',
		);

		await userEvent.click(screen.getByRole("button", { name: "閉じる" }));
		expect(screen.queryByLabelText(/適合の扱い/)).not.toBeInTheDocument();
		expect(screen.getByTestId("plan-json").textContent).not.toContain(
			"onDeviation",
		);
	});
});
