import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCALE_COOKIE } from "@/lib/i18n";
import { LocaleProvider } from "@/lib/i18n/context";
import { demoLocaleHref } from "./navigation";
import { SessionMenu } from "./session-menu";

afterEach(() => vi.unstubAllGlobals());

describe("demo language navigation", () => {
	it("preserves the complete demo screen, query and fragment across static locale documents", () => {
		const location = new URL(
			"https://example.github.io/bitovp/?theme=paper&source=guide#/demo/vod/new?from=sample&mode=copy",
		);
		expect(demoLocaleHref("ja", location)).toBe(
			"/bitovp/ja/?theme=paper&source=guide#/demo/vod/new?from=sample&mode=copy",
		);
		location.pathname = "/bitovp/ja/";
		expect(demoLocaleHref("en", location)).toBe(
			"/bitovp/?theme=paper&source=guide#/demo/vod/new?from=sample&mode=copy",
		);
	});

	it("renders language links for the selected URL locale despite a stale preference cookie", () => {
		vi.stubGlobal("window", {
			location: new URL(
				"https://example.github.io/bitovp/ja/#/demo/live/new?from=sample",
			),
		});
		vi.stubGlobal("document", { cookie: `${LOCALE_COOKIE}=en` });
		const html = renderToStaticMarkup(
			createElement(LocaleProvider, {
				locale: "ja",
				children: createElement(SessionMenu),
			}),
		);
		expect(html).toContain("デモ用ワークスペース");
		expect(html).toContain("bitovpについて");
		expect(html).not.toContain("About bitovp");
		expect(html).toContain('href="/bitovp/#/demo/live/new?from=sample"');
		expect(html).toContain('href="/bitovp/ja/#/demo/live/new?from=sample"');
		expect(html.toLowerCase()).toMatch(
			/lang="ja" hreflang="ja" aria-current="page"/,
		);
		expect(html).toContain('href="/bitovp/ja/"');
	});

	it("keeps English links and lowercase brand text on the English document", () => {
		vi.stubGlobal("window", {
			location: new URL("https://example.github.io/bitovp/#/demo"),
		});
		const html = renderToStaticMarkup(
			createElement(LocaleProvider, {
				locale: "en",
				children: createElement(SessionMenu),
			}),
		);
		expect(html).toContain("Public demo workspace");
		expect(html).toContain("About bitovp");
		expect(html).not.toMatch(/Bitovp|BitOVP/);
		expect(html.toLowerCase()).toMatch(
			/lang="en" hreflang="en" aria-current="page"/,
		);
		expect(html).toContain('href="/bitovp/"');
	});
});
