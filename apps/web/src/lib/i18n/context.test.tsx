import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCALE_COOKIE } from ".";
import { LocaleProvider, persistLocale, useT } from "./context";

/**
 * `persistLocale` and `LocaleSwitcher` shipped with NO test file, and a review
 * found five mutations that survived the full 1,678-test suite because of it:
 * dropping `Secure`, dropping `Path=/` AND `SameSite=Lax`, never reloading, and
 * `useT` falling back to English instead of throwing.
 *
 * The asymmetry is the argument for this file. The SESSION cookie's attributes are
 * pinned (`session.test.ts`), and they are pinned because getting them wrong
 * shipped a silent sign-out no-op earlier in this phase — twice, in opposite
 * directions. The locale cookie's attributes were not pinned at all, and dropping
 * `Path=/` is a real user-visible bug rather than a theoretical one: set from
 * `/vod/jobs`, the cookie would scope to `/vod` and the preference would silently
 * not apply on `/`.
 */
function cookieHeader(): string {
	return document.cookie;
}

/** The last `document.cookie` assignment, attributes included. */
let written: string[] = [];

beforeEach(() => {
	written = [];
	vi.spyOn(document, "cookie", "set").mockImplementation((value: string) => {
		written.push(value);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("persistLocale", () => {
	it("writes the locale under the expected cookie name", () => {
		persistLocale("ja");
		expect(written).toHaveLength(1);
		expect(written[0]).toContain(`${LOCALE_COOKIE}=ja`);
	});

	it("scopes to the whole site — Path=/", () => {
		// Without this the cookie inherits the current directory, so a preference set
		// on /vod/jobs would not apply on /.
		persistLocale("ja");
		expect(written[0]).toContain("Path=/");
	});

	it("sets SameSite=Lax and a long Max-Age", () => {
		persistLocale("en");
		expect(written[0]).toContain("SameSite=Lax");
		expect(written[0]).toMatch(/Max-Age=\d{7,}/);
	});

	it("is NOT HttpOnly — the switcher has to write it from script", () => {
		persistLocale("en");
		expect(written[0]).not.toContain("HttpOnly");
	});

	/**
	 * Per SCHEME, the same rule the session cookies needed. A `Secure` cookie from a
	 * non-trustworthy origin is ignored (RFC 6265bis §5.7.3), so setting it
	 * unconditionally would make the switcher a silent no-op on a plain-http
	 * install — which is how the logout route's first fix moved its bug from https
	 * to http rather than removing it.
	 */
	it("adds Secure only over https", () => {
		const original = window.location;
		try {
			Object.defineProperty(window, "location", {
				configurable: true,
				value: { ...original, protocol: "https:", reload: () => {} },
			});
			persistLocale("ja");
			expect(written[0]).toContain("Secure");

			written = [];
			Object.defineProperty(window, "location", {
				configurable: true,
				value: { ...original, protocol: "http:", reload: () => {} },
			});
			persistLocale("ja");
			expect(written[0]).not.toContain("Secure");
		} finally {
			Object.defineProperty(window, "location", {
				configurable: true,
				value: original,
			});
		}
	});

	it("leaves the real document.cookie untouched in this suite", () => {
		// Guards the spy itself — if it stopped intercepting, the assertions above
		// would be reading a cookie jar shared with every other test file.
		persistLocale("ja");
		expect(cookieHeader()).not.toContain(LOCALE_COOKIE);
	});
});

describe("useT", () => {
	function Probe() {
		const { t, locale } = useT();
		return (
			<span>
				{locale}:{t("nav.settings")}
			</span>
		);
	}

	it("translates inside a provider", () => {
		render(
			<LocaleProvider locale="ja">
				<Probe />
			</LocaleProvider>,
		);
		expect(screen.getByText("ja:設定")).toBeInTheDocument();
	});

	/**
	 * THROWS outside a provider — it does not fall back to English. A fallback would
	 * render correct-looking copy in a subtree nobody knows is un-localized, which is
	 * the same failure the catalogue's typecheck exists to prevent, reintroduced at
	 * the component layer. A reviewer showed the whole suite stayed green with the
	 * throw replaced by a fallback.
	 */
	it("throws outside a provider rather than falling back to English", () => {
		// React logs the error boundary-less throw; silence it for this assertion.
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(() => render(<Probe />)).toThrowError(/must be used inside/);
		} finally {
			spy.mockRestore();
		}
	});
});
