import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_QUICKTUNNEL_METRICS_URL,
	INGRESS_MODES,
	type IngressSnapshot,
	ingressChanged,
	ingressHostnameOf,
	nextIngressSnapshot,
	normalizeIngressBaseUrl,
	parseIngressConfig,
	parseIngressSnapshot,
	resolveIngress,
} from "./resolver";

const NOW = new Date("2026-09-02T09:00:00.000Z");
const now = () => NOW;

/** A fetch double answering the cloudflared `/quicktunnel` probe. */
function metricsFetch(
	body: unknown,
	status = 200,
): { fetch: typeof fetch; calls: string[] } {
	const calls: string[] = [];
	const doFetch = vi.fn(async (input: string | URL | Request) => {
		calls.push(String(input));
		return new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	});
	return { fetch: doFetch as unknown as typeof fetch, calls };
}

describe("parseIngressConfig", () => {
	it("defaults to static — the pre-G-1 PUBLIC_BASE_URL behaviour survives an untouched .env", () => {
		expect(parseIngressConfig({})).toEqual({
			mode: "static",
			publicBaseUrl: undefined,
			ingressHostname: undefined,
			quickTunnelMetricsUrl: DEFAULT_QUICKTUNNEL_METRICS_URL,
		});
		expect(parseIngressConfig({ INGRESS_MODE: "  " }).mode).toBe("static");
	});

	it("accepts every declared mode and refuses a typo loudly", () => {
		for (const mode of INGRESS_MODES) {
			expect(parseIngressConfig({ INGRESS_MODE: mode }).mode).toBe(mode);
		}
		// A typo must not silently become "no webhooks".
		expect(() => parseIngressConfig({ INGRESS_MODE: "quicktunnel" })).toThrow(
			/INGRESS_MODE must be one of/,
		);
	});

	it("treats blank values as unset and honours the metrics URL override", () => {
		const config = parseIngressConfig({
			INGRESS_MODE: "quick-tunnel",
			PUBLIC_BASE_URL: "",
			INGRESS_HOSTNAME: " ",
			INGRESS_QUICKTUNNEL_METRICS_URL: "http://127.0.0.1:20241/quicktunnel",
		});
		expect(config.publicBaseUrl).toBeUndefined();
		expect(config.ingressHostname).toBeUndefined();
		expect(config.quickTunnelMetricsUrl).toBe(
			"http://127.0.0.1:20241/quicktunnel",
		);
	});
});

describe("normalizeIngressBaseUrl", () => {
	it("keeps the origin only — path, trailing slash and query are dropped", () => {
		expect(normalizeIngressBaseUrl("https://OVP.Example.com/")).toBe(
			"https://ovp.example.com",
		);
		expect(normalizeIngressBaseUrl("http://localhost:3100/api/x?y=1")).toBe(
			"http://localhost:3100",
		);
	});

	it("refuses non-http schemes, credentials and garbage", () => {
		expect(normalizeIngressBaseUrl("ftp://x.example")).toBeNull();
		expect(normalizeIngressBaseUrl("https://user:pw@x.example")).toBeNull();
		expect(normalizeIngressBaseUrl("not a url")).toBeNull();
	});

	it("ingressHostnameOf lowercases and drops the port", () => {
		expect(ingressHostnameOf("https://Abc.trycloudflare.com:8443")).toBe(
			"abc.trycloudflare.com",
		);
		expect(ingressHostnameOf("nope")).toBeNull();
	});
});

describe("resolveIngress per mode", () => {
	it("none ⇒ no ingress, with the reason naming the mode", async () => {
		const result = await resolveIngress(
			parseIngressConfig({ INGRESS_MODE: "none" }),
			{ now },
		);
		expect(result).toEqual({
			ok: false,
			reason: "INGRESS_MODE=none — no public ingress",
		});
	});

	it("static reads PUBLIC_BASE_URL and normalizes it", async () => {
		const result = await resolveIngress(
			parseIngressConfig({ PUBLIC_BASE_URL: "https://ovp.example.com/" }),
			{ now },
		);
		expect(result).toEqual({
			ok: true,
			current: {
				baseUrl: "https://ovp.example.com",
				source: "PUBLIC_BASE_URL",
				observedAt: NOW.toISOString(),
			},
		});
	});

	it("static without PUBLIC_BASE_URL, or with a non-http value, resolves to nothing", async () => {
		expect(
			await resolveIngress(parseIngressConfig({ INGRESS_MODE: "static" }), {
				now,
			}),
		).toEqual({
			ok: false,
			reason: "PUBLIC_BASE_URL is not set (INGRESS_MODE=static)",
		});
		expect(
			await resolveIngress(
				parseIngressConfig({ PUBLIC_BASE_URL: "ovp.example.com" }),
				{ now },
			),
		).toEqual({ ok: false, reason: "PUBLIC_BASE_URL is not an http(s) URL" });
	});

	it("named-tunnel reads INGRESS_HOSTNAME as an https origin", async () => {
		const result = await resolveIngress(
			parseIngressConfig({
				INGRESS_MODE: "named-tunnel",
				INGRESS_HOSTNAME: "ovp.example.com",
			}),
			{ now },
		);
		expect(result).toEqual({
			ok: true,
			current: {
				baseUrl: "https://ovp.example.com",
				source: "INGRESS_HOSTNAME",
				observedAt: NOW.toISOString(),
			},
		});
		expect(
			await resolveIngress(
				parseIngressConfig({ INGRESS_MODE: "named-tunnel" }),
				{ now },
			),
		).toEqual({
			ok: false,
			reason: "INGRESS_HOSTNAME is not set (INGRESS_MODE=named-tunnel)",
		});
	});

	it("quick-tunnel asks the cloudflared metrics endpoint for its hostname", async () => {
		const probe = metricsFetch({ hostname: "abc-def.trycloudflare.com" });
		const result = await resolveIngress(
			parseIngressConfig({ INGRESS_MODE: "quick-tunnel" }),
			{ now, fetch: probe.fetch },
		);
		expect(probe.calls).toEqual([DEFAULT_QUICKTUNNEL_METRICS_URL]);
		expect(result).toEqual({
			ok: true,
			current: {
				baseUrl: "https://abc-def.trycloudflare.com",
				source: "cloudflared-quicktunnel",
				observedAt: NOW.toISOString(),
			},
		});
	});

	it("quick-tunnel: an empty hostname (tunnel not up yet) is 'nothing yet', not a URL", async () => {
		// cloudflared serves `/quicktunnel` before the edge assigned a name.
		const probe = metricsFetch({ hostname: "" });
		const result = await resolveIngress(
			parseIngressConfig({ INGRESS_MODE: "quick-tunnel" }),
			{ now, fetch: probe.fetch },
		);
		expect(result).toEqual({
			ok: false,
			reason: "cloudflared has not reported a quick-tunnel hostname yet",
		});
	});

	it("quick-tunnel: sidecar down, non-2xx and non-JSON all resolve to nothing with a reason — never throw", async () => {
		const down = vi.fn(async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		const config = parseIngressConfig({ INGRESS_MODE: "quick-tunnel" });
		const offline = await resolveIngress(config, { now, fetch: down });
		expect(offline.ok).toBe(false);
		expect(offline.ok ? "" : offline.reason).toContain("ECONNREFUSED");

		const notOk = await resolveIngress(config, {
			now,
			fetch: metricsFetch({ hostname: "x" }, 503).fetch,
		});
		expect(notOk).toEqual({
			ok: false,
			reason: `cloudflared metrics answered HTTP 503 at ${DEFAULT_QUICKTUNNEL_METRICS_URL}`,
		});

		const notJson = vi.fn(
			async () => new Response("not json", { status: 200 }),
		) as unknown as typeof fetch;
		const garbage = await resolveIngress(config, { now, fetch: notJson });
		expect(garbage.ok).toBe(false);
	});
});

describe("snapshot lifecycle", () => {
	const resolved = (baseUrl: string, observedAt = NOW.toISOString()) =>
		({
			ok: true,
			current: {
				baseUrl,
				source: "cloudflared-quicktunnel",
				observedAt,
			},
		}) as const;

	it("first resolution is a change; the same URL again is not, and keeps observedAt", () => {
		const first = nextIngressSnapshot(
			null,
			"quick-tunnel",
			resolved("https://a.trycloudflare.com"),
			NOW,
		);
		expect(ingressChanged(null, first)).toBe(true);
		const later = new Date(NOW.getTime() + 30_000);
		const second = nextIngressSnapshot(
			first,
			"quick-tunnel",
			resolved("https://a.trycloudflare.com", later.toISOString()),
			later,
		);
		expect(ingressChanged(first, second)).toBe(false);
		expect(second.checkedAt).toBe(later.toISOString());
		expect(second.current?.observedAt).toBe(NOW.toISOString());
	});

	it("a rotated tunnel URL is a change, and so is losing the URL", () => {
		const a = nextIngressSnapshot(
			null,
			"quick-tunnel",
			resolved("https://a.trycloudflare.com"),
			NOW,
		);
		const b = nextIngressSnapshot(
			a,
			"quick-tunnel",
			resolved("https://b.trycloudflare.com"),
			NOW,
		);
		expect(ingressChanged(a, b)).toBe(true);
		expect(b.current?.observedAt).toBe(NOW.toISOString());
		const lost = nextIngressSnapshot(
			b,
			"quick-tunnel",
			{ ok: false, reason: "sidecar gone" },
			NOW,
		);
		expect(lost).toEqual({
			v: 1,
			mode: "quick-tunnel",
			current: null,
			checkedAt: NOW.toISOString(),
			reason: "sidecar gone",
		});
		expect(ingressChanged(b, lost)).toBe(true);
	});

	it("no row and no ingress is NOT a change — a fresh laptop boot must not notify", () => {
		const nothing = nextIngressSnapshot(
			null,
			"static",
			{ ok: false, reason: "PUBLIC_BASE_URL is not set (INGRESS_MODE=static)" },
			NOW,
		);
		expect(ingressChanged(null, nothing)).toBe(false);
		// …but a mode switch with the same (absent) URL IS one.
		const switched = nextIngressSnapshot(
			nothing,
			"none",
			{ ok: false, reason: "INGRESS_MODE=none — no public ingress" },
			NOW,
		);
		expect(ingressChanged(nothing, switched)).toBe(true);
	});

	it("parseIngressSnapshot round-trips a stored row and rejects a malformed one", () => {
		const snapshot: IngressSnapshot = {
			v: 1,
			mode: "static",
			current: {
				baseUrl: "https://ovp.example.com",
				source: "PUBLIC_BASE_URL",
				observedAt: NOW.toISOString(),
			},
			checkedAt: NOW.toISOString(),
		};
		expect(parseIngressSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(
			snapshot,
		);
		expect(parseIngressSnapshot(null)).toBeNull();
		expect(parseIngressSnapshot({ v: 1, mode: "static" })).toBeNull();
		expect(
			parseIngressSnapshot({ ...snapshot, current: { baseUrl: "x" } }),
		).toBeNull();
	});
});
