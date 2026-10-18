import BitmovinApi from "@bitmovin/api-sdk";
import { describe, expect, it, vi } from "vitest";
import * as registrationModule from "./webhook-registration";
import {
	comparableUrl,
	kindApi,
	listRegistrations,
	REGISTRATION_KINDS,
	REQUIRED_KIND_METHODS,
} from "./webhook-registration";

/**
 * Review-187 C1's permanent answer: the first cut's mock MANUFACTURED the
 * SDK surface (every kind handed an identical full triad) while the real
 * liveInputStreamChanged class has no list and no deleteByWebhookId — the
 * feature shipped 100% non-functional under six green tests. This probe
 * runs against the REAL pinned SDK object: every kind the code manages must
 * expose every method the code calls, walked up the prototype chain. A kind
 * added to REGISTRATION_KINDS without the triad fails HERE, not in
 * production as a curated 502.
 */

describe("REGISTRATION_KINDS × the real SDK surface", () => {
	const api = new BitmovinApi({ apiKey: "structural-probe-only" });

	for (const kind of REGISTRATION_KINDS) {
		it(`${kind} exposes ${REQUIRED_KIND_METHODS.join("/")} on the pinned SDK`, () => {
			const target = kindApi(api, kind);
			expect(target, kind).toBeDefined();
			for (const method of REQUIRED_KIND_METHODS) {
				expect(
					typeof (target as unknown as Record<string, unknown>)[method],
					`${kind}.${method}`,
				).toBe("function");
			}
		});
	}

	it("liveInputStreamChanged is create-only — the documented exclusion holds", () => {
		// If an SDK upgrade ever grants it the triad, this goes RED so the
		// exclusion gets re-examined instead of silently staying stale.
		const group = api.notifications.webhooks.encoding
			.encodings as unknown as Record<string, Record<string, unknown>>;
		const excluded = group.liveInputStreamChanged;
		expect(excluded).toBeDefined();
		expect(typeof excluded?.create).toBe("function");
		expect(excluded?.list).toBeUndefined();
		expect(excluded?.deleteByWebhookId).toBeUndefined();
	});
});

describe("comparableUrl", () => {
	it("normalizes scheme/host case and a trailing slash; keeps path case", () => {
		expect(
			comparableUrl("HTTPS://OVP.Example.com/api/webhooks/bitmovin/"),
		).toBe("https://ovp.example.com/api/webhooks/bitmovin");
		expect(comparableUrl("https://ovp.example.com/API/CASE")).toBe(
			"https://ovp.example.com/API/CASE",
		);
	});

	it("an unparsable string compares verbatim (never throws)", () => {
		expect(comparableUrl("not a url")).toBe("not a url");
	});
});

describe("listRegistrations ours/legacy flags (WP-G G-1b/G-2)", () => {
	const CURRENT =
		"https://ovp.example.com/api/webhooks/bitmovin/acct/AAAAAAAAAAAAAAAAAAAAAA";
	const LEGACY = "https://ovp.example.com/api/webhooks/bitmovin";
	const endpoints = { current: CURRENT, legacy: LEGACY };

	function apiWith(items: { id: string; url: string }[]) {
		const api = {
			notifications: {
				webhooks: {
					encoding: {
						encodings: Object.fromEntries(
							REGISTRATION_KINDS.map((kind) => [
								kind,
								{ list: vi.fn().mockResolvedValue({ items }) },
							]),
						),
					},
				},
			},
		} as unknown as Parameters<typeof listRegistrations>[0];
		return { api };
	}

	it("flags the signed acct endpoint as ours, the pre-G-1 endpoint as ours+legacy, anything else as external", async () => {
		const { api } = apiWith([
			{ id: "wh-signed", url: `${CURRENT}/` },
			{ id: "wh-legacy", url: LEGACY },
			{ id: "wh-other", url: "https://elsewhere.example.com/hook" },
		]);
		const rows = await listRegistrations(api, endpoints);
		const byId = new Map(rows.map((row) => [row.id, row]));
		expect(byId.get("wh-signed")).toMatchObject({ ours: true, legacy: false });
		expect(byId.get("wh-legacy")).toMatchObject({ ours: true, legacy: true });
		expect(byId.get("wh-other")).toMatchObject({ ours: false, legacy: false });
	});

	it("the account-level module no longer registers anything — per-encoding registration is the worker's", () => {
		// The G-2 invariant, pinned at the module boundary: no create-shaped
		// export remains, so a route cannot quietly bring the standard set back.
		expect(Object.keys(registrationModule)).not.toContain(
			"registerStandardSet",
		);
		expect(REQUIRED_KIND_METHODS).toEqual(["list", "deleteByWebhookId"]);
	});
});

describe("listRegistrations pagination bound", () => {
	it("an upstream that always returns a full page stops at the cap and WARNS", async () => {
		// review-187's re-verdict: the first pagination fix did not terminate —
		// proven at 2001 calls against a constant-full-page stub. C24's
		// convention: bound it, and never cap silently.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fullPage = {
			items: Array.from({ length: 100 }, (_, i) => ({
				id: `wh-${i}`,
				url: "https://elsewhere.example.com/hook",
			})),
		};
		const list = vi.fn().mockResolvedValue(fullPage);
		const api = {
			notifications: {
				webhooks: {
					encoding: {
						encodings: Object.fromEntries(
							REGISTRATION_KINDS.map((kind) => [kind, { list }]),
						),
					},
				},
			},
		} as unknown as Parameters<typeof listRegistrations>[0];
		const rows = await listRegistrations(api, { current: null, legacy: null });
		// 4 kinds × 5 pages, not unbounded.
		expect(list).toHaveBeenCalledTimes(20);
		expect(rows).toHaveLength(2000);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("stopped listing after 5 full pages"),
		);
		warn.mockRestore();
	});
});
