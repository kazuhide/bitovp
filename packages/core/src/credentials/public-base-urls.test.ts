import { describe, expect, it } from "vitest";
import {
	formatPublicBaseUrls,
	normalizeBaseUrl,
	parsePublicBaseUrls,
	readPublicBaseUrls,
} from "./public-base-urls";

describe("normalizeBaseUrl", () => {
	it("accepts an https origin, with or without a path", () => {
		expect(normalizeBaseUrl("https://cdn.example.com")).toBe(
			"https://cdn.example.com",
		);
		expect(normalizeBaseUrl("https://cdn.example.com/vod")).toBe(
			"https://cdn.example.com/vod",
		);
	});

	it("accepts http — a mixed-content warning is the URL builder's job", () => {
		expect(normalizeBaseUrl("http://origin.internal:8080")).toBe(
			"http://origin.internal:8080",
		);
	});

	it("strips trailing slashes and surrounding whitespace", () => {
		expect(normalizeBaseUrl("  https://cdn.example.com/vod//  ")).toBe(
			"https://cdn.example.com/vod",
		);
	});

	it("rejects anything that would break the appended object path", () => {
		for (const bad of [
			"cdn.example.com",
			"/vod",
			"ftp://cdn.example.com",
			"s3://bucket/prefix",
			// A query or fragment lands BEFORE the appended path, so every URL
			// built from it would be wrong rather than merely ugly.
			"https://cdn.example.com/vod?token=x",
			"https://cdn.example.com/vod#frag",
			// URL userinfo, refused for the same reason `secretEgressUrlSchema`
			// refuses it: `Credential.config` is stored RAW because it is
			// non-secret by construction, and this value additionally becomes a
			// `<video src>` and clipboard text.
			"https://user:pass@cdn.example.com",
			"https://user@cdn.example.com",
			"",
			"   ",
			undefined,
			42,
		]) {
			expect(normalizeBaseUrl(bad), String(bad)).toBeNull();
		}
	});
});

describe("readPublicBaseUrls", () => {
	it("reads the map off a credential config", () => {
		expect(
			readPublicBaseUrls({
				region: "eu-west-1",
				publicBaseUrls: { a: "https://a.example", b: "https://b.example" },
			}),
		).toEqual({ a: "https://a.example", b: "https://b.example" });
	});

	it("returns an empty map for every shape a hand-edited row could hold", () => {
		for (const config of [
			undefined,
			{},
			{ publicBaseUrls: null },
			{ publicBaseUrls: "https://cdn.example.com" },
			{ publicBaseUrls: ["https://cdn.example.com"] },
			{ publicBaseUrls: 7 },
		]) {
			expect(readPublicBaseUrls(config), JSON.stringify(config)).toEqual({});
		}
	});

	it("drops non-string values but keeps the usable siblings", () => {
		expect(
			readPublicBaseUrls({
				publicBaseUrls: { good: "https://a.example", bad: 5 },
			}),
		).toEqual({ good: "https://a.example" });
	});
});

describe("parsePublicBaseUrls / formatPublicBaseUrls", () => {
	it("round-trips the form's text representation", () => {
		const map = {
			"out-bucket": "https://cdn.example.com/vod",
			assets: "https://acct.blob.core.windows.net/assets",
		};
		const parsed = parsePublicBaseUrls(formatPublicBaseUrls(map));
		expect(parsed).toEqual({ ok: true, value: map });
	});

	it("treats blank text as 'field absent', not as an empty map", () => {
		// `normalize` in the credential form omits blank optional fields
		// entirely; an empty object would persist a meaningless key.
		expect(parsePublicBaseUrls("")).toEqual({ ok: true, value: undefined });
		expect(parsePublicBaseUrls("\n  \n\t\n")).toEqual({
			ok: true,
			value: undefined,
		});
	});

	it("accepts either separator and any spacing around it", () => {
		const parsed = parsePublicBaseUrls(
			"a=https://a.example\nb = https://b.example\nc\thttps://c.example\n  d   https://d.example  ",
		);
		expect(parsed).toEqual({
			ok: true,
			value: {
				a: "https://a.example",
				b: "https://b.example",
				c: "https://c.example",
				d: "https://d.example",
			},
		});
	});

	it("normalizes each value as it parses", () => {
		expect(parsePublicBaseUrls("a = https://a.example/vod/")).toEqual({
			ok: true,
			value: { a: "https://a.example/vod" },
		});
	});

	it("names the line for a missing separator", () => {
		const parsed = parsePublicBaseUrls("a = https://a.example\nnonsense");
		expect(parsed.ok).toBe(false);
		expect(parsed.ok === false && parsed.error).toContain("line 2");
	});

	it("names the line and the bucket for an unusable base", () => {
		const parsed = parsePublicBaseUrls("a = https://a.example\nb = nope");
		expect(parsed.ok).toBe(false);
		expect(parsed.ok === false && parsed.error).toContain("line 2 (b)");
	});

	it("rejects a bucket listed twice rather than silently keeping one", () => {
		const parsed = parsePublicBaseUrls(
			"a = https://a.example\na = https://b.example",
		);
		expect(parsed.ok).toBe(false);
		expect(parsed.ok === false && parsed.error).toContain("listed twice");
	});

	it("formats an absent map as empty text", () => {
		expect(formatPublicBaseUrls(undefined)).toBe("");
		expect(formatPublicBaseUrls(null)).toBe("");
		expect(formatPublicBaseUrls({})).toBe("");
	});
});

describe("normalizeBaseUrl — the displayed host must be the fetched host", () => {
	/**
	 * Every check ran against the parsed URL while the return value was the raw
	 * input — validate one form, use another. All four of these were accepted and
	 * flagged fully playable; HLS/DASH resolve segments relative to the manifest,
	 * so one deceptive base redirects the entire segment chain, and the URL is
	 * rendered in a truncating span that clips exactly where `@evil.tld` sits.
	 */
	it("rejects a %2f@ authority outright — it parses as userinfo", () => {
		// `cdn.example.com%2f` becomes the username, so the userinfo guard catches
		// it before the origin rewrite does. Rejected is stronger than collapsed.
		expect(
			normalizeBaseUrl("https://cdn.example.com%2f@evil.tld/vod"),
		).toBeNull();
	});

	it("never returns a value that reads as one host and fetches another", () => {
		/**
		 * The property that matters, asserted over the deceptive forms rather than
		 * over one of them: whatever comes back, its own host is the host a browser
		 * would contact. Rejection satisfies this; so does a punycode rewrite.
		 */
		for (const deceptive of [
			"https://cdn.example.com%2f@evil.tld/vod",
			"https://evil.tld\\@cdn.example.com/vod",
			"https://user@cdn.example.com/vod",
			"https://\u0430pple.com/vod",
		]) {
			const out = normalizeBaseUrl(deceptive);
			if (out === null) {
				continue;
			}
			// The returned string LEADS with the origin a browser would contact, so
			// the host cannot be misread — a deceptive authority is demoted into the
			// path, where it is visibly after the real host.
			expect(out, deceptive).toBe(
				`${new URL(out).origin}${new URL(out).pathname}`.replace(/\/+$/, ""),
			);
			// And normalising is idempotent: no second reading changes the host.
			expect(normalizeBaseUrl(out), deceptive).toBe(out);
		}
	});

	it("demotes a backslash authority into the path, leading with the real host", () => {
		// `\` is a path separator to WHATWG, so this reads as cdn.example.com and
		// fetches evil.tld. After normalising it says evil.tld first.
		expect(normalizeBaseUrl("https://evil.tld\\@cdn.example.com/vod")).toBe(
			"https://evil.tld/@cdn.example.com/vod",
		);
	});

	it("punycodes an IDN homograph instead of showing the lookalike", () => {
		// Cyrillic а — indistinguishable from Latin a in the UI.
		const out = normalizeBaseUrl("https://\u0430pple.com/vod");
		expect(out).toBe("https://xn--pple-43d.com/vod");
	});

	it("rejects a bare trailing ? or # — WHATWG reports those as empty", () => {
		/**
		 * `new URL("https://cdn.x/vod#").hash` is `""`, so the parsed check passed
		 * them; the appended object path then became a fragment and the browser
		 * fetched `/vod`.
		 */
		for (const bad of [
			"https://cdn.example.com/vod#",
			"https://cdn.example.com/vod?",
			"https://cdn.example.com#",
		]) {
			expect(normalizeBaseUrl(bad), bad).toBeNull();
		}
		expect(parsePublicBaseUrls("b = https://cdn.example.com/vod#").ok).toBe(
			false,
		);
	});

	it("still round-trips an ordinary base unchanged", () => {
		// The control: normalising through `parsed` must not rewrite good input.
		for (const good of [
			"https://cdn.example.com",
			"https://cdn.example.com/vod",
			"http://origin.internal:8080/live",
		]) {
			expect(normalizeBaseUrl(good), good).toBe(good);
		}
	});
});

describe("prototype keys are not declared bases", () => {
	/**
	 * `constructor` is a valid S3 bucket name. On a `{}` literal,
	 * `map["constructor"]` returns `Function.prototype.constructor` — truthy, a
	 * function — so a bucket with NO declared base was reported as having an
	 * unusable one (`MISSING_BASE_URL`), sending the operator to fix a map entry
	 * that does not exist.
	 */
	it("returns a map with no inherited keys", () => {
		const map = readPublicBaseUrls({
			publicBaseUrls: { out: "https://a.dev" },
		});
		expect(Object.getPrototypeOf(map)).toBeNull();
		for (const key of [
			"constructor",
			"toString",
			"hasOwnProperty",
			"__proto__",
		]) {
			expect(map[key], key).toBeUndefined();
		}
	});

	it("still resolves a bucket that IS named after a prototype key", () => {
		// The control: rejecting inherited keys must not reject a real entry that
		// happens to be spelled that way.
		const map = readPublicBaseUrls({
			publicBaseUrls: { constructor: "https://cdn.dev/vod" },
		});
		expect(map.constructor).toBe("https://cdn.dev/vod");
	});
});

describe("readPublicBaseUrls — inherited properties", () => {
	it("ignores an inherited publicBaseUrls", () => {
		// The returned map is null-prototype, but the lookup that produced it was a
		// bare property read, so a prototype carrying `publicBaseUrls` was honoured.
		// Unreachable through Prisma (JSON.parse yields own properties only); pinned
		// because the fix is invisible otherwise.
		const inherited = Object.create({
			publicBaseUrls: { out: "https://attacker.tld" },
		}) as Record<string, unknown>;
		expect(readPublicBaseUrls(inherited)).toEqual({});
	});

	it("still reads an own publicBaseUrls", () => {
		expect(
			readPublicBaseUrls({ publicBaseUrls: { out: "https://cdn.dev" } }),
		).toEqual({ out: "https://cdn.dev" });
	});
});
