import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NotFoundView } from "@/app/not-found-view";
import { renderLocalized as renderL } from "@/test/render";

/**
 * Before this component existed, a bad URL rendered Next.js's own built-in
 * "404 / This page could not be found." — English, inside chrome that is otherwise
 * fully Japanese. Nothing could catch it: there was no component to assert on, and
 * the i18n catalogue checks can only inspect strings that are IN the catalogue. It
 * was found by reading `document.body.innerText` off the running app
 * (`apps/worker/scripts/ja-render-sweep.ts`), which is the only instrument that sees
 * this class.
 */
describe("NotFoundView", () => {
	it("renders localized copy in Japanese, not Next's English default", () => {
		renderL(<NotFoundView />, "ja");
		expect(screen.getByText("ページが見つかりません")).toBeInTheDocument();
		// The exact string Next.js would have shown must NOT be present.
		expect(screen.queryByText(/This page could not be found/)).toBeNull();
	});

	it("renders localized copy in English", () => {
		renderL(<NotFoundView />, "en");
		expect(screen.getByText("Page not found")).toBeInTheDocument();
	});

	it("explains the likely cause rather than only stating the code", () => {
		// A 404 in this app is most often a link to a deleted job or report, which is
		// a normal thing to have happened — so the copy says so instead of implying
		// the operator mistyped.
		renderL(<NotFoundView />, "en");
		expect(screen.getByText(/deleted/)).toBeInTheDocument();
	});

	it("offers a way out", () => {
		renderL(<NotFoundView />, "ja");
		const link = screen.getByRole("link", { name: "ダッシュボードに戻る" });
		expect(link).toHaveAttribute("href", "/");
	});
});
