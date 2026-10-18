import { describe, expect, it } from "vitest";
import {
	checkPlaybackCors,
	type PlaybackCorsRule,
	RANGE_RESPONSE_HEADERS,
} from "./cors";

const ORIGIN = "http://localhost:3100";

function rule(over: Partial<PlaybackCorsRule> = {}): PlaybackCorsRule {
	return {
		allowedOrigins: ["*"],
		allowedMethods: ["GET", "HEAD"],
		allowedHeaders: ["*"],
		exposeHeaders: ["Content-Range", "Accept-Ranges", "Content-Length"],
		...over,
	};
}

describe("checkPlaybackCors", () => {
	it("passes a rule that allows the origin, Range, and exposes the range headers", () => {
		expect(checkPlaybackCors([rule()], { origin: ORIGIN })).toEqual({
			code: "OK",
		});
	});

	it("reports the real bucket's actual shape: permissive, but nothing exposed", () => {
		/**
		 * Measured : AllowedOrigins ["*"], AllowedHeaders ["*"], a
		 * preflight that returns `Access-Control-Allow-Headers: range` — and no
		 * `Access-Control-Expose-Headers` on any response. This is the case the
		 * whole check exists for, so it is asserted from the measured config
		 * rather than a synthetic one.
		 */
		const verdict = checkPlaybackCors(
			[
				{
					allowedOrigins: ["*"],
					allowedMethods: ["GET", "HEAD"],
					allowedHeaders: ["*"],
					exposeHeaders: [],
				},
			],
			{ origin: ORIGIN },
		);
		expect(verdict).toEqual({
			code: "MISSING_EXPOSE_HEADERS",
			headers: [...RANGE_RESPONSE_HEADERS],
		});
	});

	it("names only the headers actually missing", () => {
		expect(
			checkPlaybackCors([rule({ exposeHeaders: ["Content-Length"] })], {
				origin: ORIGIN,
			}),
		).toEqual({
			code: "MISSING_EXPOSE_HEADERS",
			headers: ["content-range", "accept-ranges"],
		});
	});

	it("folds header case — CORS header names are case-insensitive", () => {
		expect(
			checkPlaybackCors(
				[
					rule({
						exposeHeaders: [
							"CONTENT-RANGE",
							"accept-ranges",
							" Content-Length ",
						],
					}),
				],
				{ origin: ORIGIN },
			),
		).toEqual({ code: "OK" });
	});

	it("honours a wildcard in ExposeHeaders even though S3 rejects one", () => {
		// Other providers accept it; reporting a false miss would send the
		// operator to fix a rule that is already correct.
		expect(
			checkPlaybackCors([rule({ exposeHeaders: ["*"] })], { origin: ORIGIN }),
		).toEqual({ code: "OK" });
	});

	it("distinguishes 'no configuration' from a matching rule that is wrong", () => {
		expect(checkPlaybackCors(null, { origin: ORIGIN })).toEqual({
			code: "NO_RULES",
		});
		expect(checkPlaybackCors([], { origin: ORIGIN })).toEqual({
			code: "NO_RULES",
		});
	});

	it("requires the Range REQUEST header, not merely the response ones", () => {
		expect(
			checkPlaybackCors([rule({ allowedHeaders: ["Authorization"] })], {
				origin: ORIGIN,
			}),
		).toEqual({ code: "RANGE_HEADER_NOT_ALLOWED" });
		// Named explicitly is enough — the wildcard is not required.
		expect(
			checkPlaybackCors([rule({ allowedHeaders: ["range"] })], {
				origin: ORIGIN,
			}),
		).toEqual({ code: "OK" });
	});

	it("matches an exact origin, and treats scheme/port as part of it", () => {
		const rules = [rule({ allowedOrigins: ["http://localhost:3100"] })];
		expect(checkPlaybackCors(rules, { origin: ORIGIN })).toEqual({
			code: "OK",
		});
		for (const other of [
			"https://localhost:3100",
			"http://localhost:3000",
			"http://127.0.0.1:3100",
		]) {
			expect(checkPlaybackCors(rules, { origin: other }), other).toEqual({
				code: "ORIGIN_NOT_ALLOWED",
				origin: other,
			});
		}
	});

	it("honours S3's single-wildcard origin patterns", () => {
		const rules = [rule({ allowedOrigins: ["https://*.example.com"] })];
		expect(
			checkPlaybackCors(rules, { origin: "https://ovp.example.com" }),
		).toEqual({ code: "OK" });
		expect(
			checkPlaybackCors(rules, { origin: "https://example.com" }),
		).toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
		// The wildcard must not swallow the scheme.
		expect(
			checkPlaybackCors(rules, { origin: "http://ovp.example.com" }),
		).toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
	});

	it("requires GET — a PUT-only rule does not serve a player", () => {
		expect(
			checkPlaybackCors([rule({ allowedMethods: ["PUT", "POST"] })], {
				origin: ORIGIN,
			}),
		).toEqual({ code: "ORIGIN_NOT_ALLOWED", origin: ORIGIN });
	});

	it("evaluates the FIRST matching rule, as a browser does", () => {
		/**
		 * A later, more permissive rule does not rescue an earlier match. Getting
		 * this wrong would report OK on a bucket that fails in Chrome — the exact
		 * false green this check must not produce.
		 */
		const verdict = checkPlaybackCors(
			[
				rule({ allowedOrigins: [ORIGIN], exposeHeaders: [] }),
				rule({ allowedOrigins: ["*"] }),
			],
			{ origin: ORIGIN },
		);
		expect(verdict).toMatchObject({ code: "MISSING_EXPOSE_HEADERS" });
	});

	it("skips a non-matching rule to reach a matching one", () => {
		// The control for the case above: first-match must mean first MATCHING,
		// not first in the list.
		expect(
			checkPlaybackCors(
				[
					rule({
						allowedOrigins: ["https://other.example"],
						exposeHeaders: [],
					}),
					rule({ allowedOrigins: [ORIGIN] }),
				],
				{ origin: ORIGIN },
			),
		).toEqual({ code: "OK" });
	});
});

describe("checkPlaybackCors — a wildcard origin still needs its scheme", () => {
	/**
	 * The false green this predicate must never produce. S3 matches
	 * `AllowedOrigin` against the whole `Origin` header, which always carries a
	 * scheme, so `*.example.com` matches nothing — yet the head/tail split gave
	 * `head === ""` for a leading `*` and never required one. Chrome hard-fails
	 * while the panel says "CORS is not the cause".
	 */
	it("refuses a scheme-less wildcard instead of reporting OK", () => {
		expect(
			checkPlaybackCors([rule({ allowedOrigins: ["*.example.com"] })], {
				origin: "https://app.example.com",
			}),
		).toEqual({
			code: "ORIGIN_NOT_ALLOWED",
			origin: "https://app.example.com",
		});
	});

	it("still honours a wildcard that carries one", () => {
		// The control — the fix must not break the documented S3 form.
		expect(
			checkPlaybackCors([rule({ allowedOrigins: ["https://*.example.com"] })], {
				origin: "https://app.example.com",
			}),
		).toEqual({ code: "OK" });
	});

	it("refuses a bare-host wildcard and a scheme-relative one", () => {
		for (const pattern of ["*example.com", "//*.example.com", "app.*.com"]) {
			expect(
				checkPlaybackCors([rule({ allowedOrigins: [pattern] })], {
					origin: "https://app.example.com",
				}),
				pattern,
			).toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
		}
	});

	it("folds the method wildcard too", () => {
		// `[" * "]` was the file's one un-folded read and fell through to
		// ORIGIN_NOT_ALLOWED — a false RED, but the same class of bug.
		expect(
			checkPlaybackCors([rule({ allowedMethods: [" * "] })], {
				origin: "http://localhost:3100",
			}),
		).toEqual({ code: "OK" });
	});
});
