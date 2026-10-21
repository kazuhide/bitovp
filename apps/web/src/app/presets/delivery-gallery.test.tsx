import { DELIVERY_SPECS } from "@bitovp/core";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureFlagsProvider } from "@/lib/feature-flags/context";
import { renderWithQuery } from "@/test/render";

/**
 *  (review-265 131-A9): the suggested-QC-gate line is flag-gated
 * and the provider's own default is OFF. These cases assert the full gallery,
 * so the helper renders with QC/VMAF ON; the pin at the bottom covers OFF.
 */
function wrap(
	node: React.ReactElement,
	locale: "en" | "ja" = "en",
	qcVmaf = true,
) {
	return renderWithQuery(
		<FeatureFlagsProvider flags={{ qcVmaf }}>{node}</FeatureFlagsProvider>,
		locale,
	);
}

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { DeliveryGallery } from "./delivery-gallery";

/**
 * Delivery gallery : the requirements table IS the checker's
 * constraint list (one source), export produces the org-authorable file, and
 * import saves through /api/presets with the spec BESIDE the bare plan body
 * (the userPreset wizard load depends on body staying a plan).
 */

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
			: { id: "saved" },
	);
});

describe("DeliveryGallery", () => {
	it("renders every shipped spec with its FULL constraints table (ja)", () => {
		wrap(<DeliveryGallery specs={[...DELIVERY_SPECS]} />, "ja");
		for (const spec of DELIVERY_SPECS) {
			// Scoped per card: some requirement sentences repeat across specs
			// ("Progressive MP4 video file…"), so a global getByText throws
			// multiple-found — within(card) is the honest join anyway (the
			// presence-is-not-association lesson).
			const card = screen.getByText(spec.name).closest("li");
			expect(card).not.toBeNull();
			for (const constraint of spec.constraints) {
				expect(
					within(card as HTMLElement).getByText(constraint.requirement),
				).toBeInTheDocument();
			}
		}
		expect(
			screen.getAllByText("推奨 QC ゲート: VMAF_MEAN ≥ 95(参考値)"),
		).toHaveLength(DELIVERY_SPECS.length);
	});

	it("import posts the plan as BODY and the constraints as SPEC (never combined)", async () => {
		const spec = DELIVERY_SPECS[0];
		if (!spec) {
			throw new Error("no specs");
		}
		wrap(<DeliveryGallery specs={[...DELIVERY_SPECS]} />, "ja");
		const user = userEvent.setup();
		const file = new File(
			[
				JSON.stringify({
					formatVersion: 1,
					spec: { ...spec, id: "org-spec", name: "Org spec" },
				}),
			],
			"org.bitovp-preset.json",
			{ type: "application/json" },
		);
		await user.upload(
			await screen.findByLabelText("プリセットファイルを取り込む"),
			file,
		);
		await waitFor(() => {
			expect(apiFetch).toHaveBeenCalled();
		});
		const call = apiFetch.mock.calls.find(([url]) => url === "/api/presets");
		expect(call).toBeDefined();
		const [url, init] = call as [string, RequestInit];
		expect(url).toBe("/api/presets");
		const body = JSON.parse(String(init.body)) as {
			name: string;
			plan: { renditions: unknown[] };
			category: string;
			spec: { constraints: unknown[] };
		};
		expect(body.name).toBe("Org spec");
		expect(body.plan.renditions).toHaveLength(2);
		expect(body.category).toBe("MEZZANINE");
		expect(body.spec.constraints).toHaveLength(spec.constraints.length);
		// The spec metadata NEVER contains the plan (body stays a bare plan).
		expect("plan" in body.spec).toBe(false);
	});

	it("a malformed file shows the error and posts nothing", async () => {
		wrap(<DeliveryGallery specs={[...DELIVERY_SPECS]} />, "ja");
		const user = userEvent.setup();
		await user.upload(
			await screen.findByLabelText("プリセットファイルを取り込む"),
			new File(["not json"], "bad.json", { type: "application/json" }),
		);
		expect(
			await screen.findByText(/取り込みに失敗しました/),
		).toBeInTheDocument();
		expect(apiFetch.mock.calls.some(([url]) => url === "/api/presets")).toBe(
			false,
		);
	});

	it("self-deviations are SHOWN while the import still saves", async () => {
		const spec = DELIVERY_SPECS[0];
		if (!spec) {
			throw new Error("no specs");
		}
		const loose = JSON.parse(
			JSON.stringify({
				formatVersion: 1,
				spec: { ...spec, id: "x2", name: "x2" },
			}),
		) as { spec: { constraints: { expect: unknown }[] } };
		const first = loose.spec.constraints[0];
		if (!first) {
			throw new Error("no constraints");
		}
		first.expect = { eq: "AV1" };
		wrap(<DeliveryGallery specs={[...DELIVERY_SPECS]} />, "ja");
		const user = userEvent.setup();
		await user.upload(
			await screen.findByLabelText("プリセットファイルを取り込む"),
			new File([JSON.stringify(loose)], "x2.json", {
				type: "application/json",
			}),
		);
		expect(
			await screen.findByText(
				/要件を満たさない設定が 1 件ある状態で取り込みました/,
			),
		).toBeInTheDocument();
		expect(apiFetch).toHaveBeenCalled();
	});
	it("drops the suggested QC gate line when QC/VMAF is OFF — no recommendation for a feature the deployment does not have (review-265 131-A9)", () => {
		const off = wrap(
			<DeliveryGallery specs={[...DELIVERY_SPECS]} />,
			"ja",
			false,
		);
		expect(screen.queryByText(/VMAF_MEAN/)).not.toBeInTheDocument();
		// The rest of the card survives — a gate that hid the gallery would
		// also pass a bare absence check.
		expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
		off.unmount();

		wrap(<DeliveryGallery specs={[...DELIVERY_SPECS]} />, "ja", true);
		expect(screen.getAllByText(/VMAF_MEAN/).length).toBeGreaterThan(0);
	});
});
