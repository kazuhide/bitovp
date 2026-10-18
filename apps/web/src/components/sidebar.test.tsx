import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FeatureFlagsProvider } from "@/lib/feature-flags/context";
import { type Locale, messagesFor, translate } from "@/lib/i18n";
import { renderWithQuery } from "@/test/render";
import { NAV_SECTIONS } from "./nav-items";
import { Sidebar } from "./sidebar";

vi.mock("next/navigation", () => ({
	usePathname: () => "/vod/jobs",
}));

// The nav filters by the session's role and fails
// CLOSED while the answer is pending, so a pending query hides the Storage
// entry from the IA loop below. A PASSWORD-mode session is the
// single-owner install with no role model — every destination renders, which
// is what this file pins. The role matrix itself lives in nav-list.test.tsx.
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: () =>
		Promise.resolve({
			mode: "password",
			configured: true,
			authenticated: true,
			loginKind: "password-form",
		}),
}));

function renderSidebar(locale: Locale = "en", qcVmaf = true) {
	// : the nav's QC entry is flag-gated, and the provider's own
	// default is OFF (a fresh deployment). The IA loop below asserts EVERY
	// item, so it renders with the flag ON; the pair of pins at the bottom
	// covers both states.
	return renderWithQuery(
		<FeatureFlagsProvider flags={{ qcVmaf }}>
			<Sidebar />
		</FeatureFlagsProvider>,
		locale,
	);
}

describe("Sidebar", () => {
	/**
	 * Runs for both locales — but a reviewer showed this loop is WEAKER than the PR
	 * claimed: it computes its expectation with `translate(messagesFor(locale), …)`,
	 * the same call the component makes, so a mutation to `messagesFor` moves both
	 * sides in lockstep and the loop stays green. It catches a dropped provider and
	 * a raw-key render; it does not catch "the catalogue was never consulted".
	 *
	 * What catches that is the hardcoded-string test below. Keeping both: this one
	 * proves every nav item resolves and links correctly, which hardcoding 13 labels
	 * would make unreadable.
	 */
	for (const locale of ["en", "ja"] as const) {
		it(`renders every IA nav item with its href (${locale})`, async () => {
			renderSidebar(locale);
			const messages = messagesFor(locale);
			for (const section of NAV_SECTIONS) {
				for (const item of section.items) {
					const name = translate(messages, item.labelKey);
					// findBy: privileged entries appear once the session
					// resolves (fail closed until then).
					const link = await screen.findByRole("link", { name });
					expect(link).toHaveAttribute("href", item.href);
				}
			}
		});
	}

	/**
	 * HARDCODED Japanese, one per section, and this is the test that actually pins
	 * the catalogue. `messagesFor` always returning `en` survives the loop above and
	 * fails only here — with one string it failed by 1 test, which is thinner than a
	 * feature this size deserves.
	 *
	 * Written out rather than looked up on purpose: a literal cannot mutate in
	 * lockstep with the implementation.
	 */
	const JAPANESE_LABELS: [href: string, label: string][] = [
		["/live", "ライブチャンネル"],
		["/vod/jobs", "VOD ジョブ"],
		["/live/feeders", "疑似ライブ配信"],
		["/qc", "VMAF ラボ"],
		["/storage", "ストレージ"],
		["/presets", "テンプレート"],
		["/settings", "設定"],
		["/", "ダッシュボード"],
	];

	it("renders JAPANESE labels under the ja locale, not English ones", async () => {
		renderSidebar("ja");
		// Storage lands after the session resolves; wait for it so the loop
		// below reads the settled tree.
		await screen.findByRole("link", { name: "ストレージ" });
		for (const [href, label] of JAPANESE_LABELS) {
			expect(screen.getByRole("link", { name: label })).toHaveAttribute(
				"href",
				href,
			);
		}
		expect(
			screen.queryByRole("link", { name: "API カバレッジ" }),
		).not.toBeInTheDocument();
		// And none of the English originals survive anywhere in the nav.
		for (const english of [
			"Live Channels",
			"VOD Jobs",
			"Pseudo-Live Feeds",
			"VMAF Lab",
			"Storage",
			"Presets & Templates",
			"Settings",
			"Dashboard",
			"API coverage",
		]) {
			expect(
				screen.queryByRole("link", { name: english }),
				english,
			).not.toBeInTheDocument();
		}
	});

	it("renders the section headings and tagline in Japanese too", async () => {
		// The nav ITEMS could be translated while the chrome around them is not.
		renderSidebar("ja");
		await screen.findByText("システム");
		for (const text of [
			"プラットフォーム",
			"ライブラリ",
			"システム",
			"エンコード管理コンソール",
		]) {
			expect(screen.getByText(text), text).toBeInTheDocument();
		}
	});

	it("marks the current route with aria-current", () => {
		renderSidebar();
		expect(screen.getByRole("link", { name: "VOD Jobs" })).toHaveAttribute(
			"aria-current",
			"page",
		);
		expect(screen.getByRole("link", { name: "Dashboard" })).not.toHaveAttribute(
			"aria-current",
		);
	});
	it("hides the VMAF Lab entry when QC/VMAF is OFF, and shows it when ON (ledger #131)", () => {
		const off = renderSidebar("en", false);
		expect(
			screen.queryByRole("link", { name: "VMAF Lab" }),
		).not.toBeInTheDocument();
		// Every OTHER entry survives the filter — a gate that hid the whole
		// section would also pass a bare absence check.
		expect(screen.getByRole("link", { name: "VOD Jobs" })).toBeInTheDocument();
		off.unmount();

		renderSidebar("en", true);
		expect(screen.getByRole("link", { name: "VMAF Lab" })).toBeInTheDocument();
	});
});
