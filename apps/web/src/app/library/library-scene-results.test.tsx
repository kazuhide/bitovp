import { screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { LibrarySceneHit } from "@/lib/library-scenes";
import { renderLocalized } from "@/test/render";

vi.mock("./catalog-thumbnail", () => ({
	CatalogThumbnail: () => <div data-testid="thumbnail" />,
}));

import { LibrarySceneResults } from "./library-scene-results";

const hit: LibrarySceneHit = {
	contentId: "content",
	contentTitle: "Nature film",
	contentRevision: 3,
	analysisRevisionId: "a1111111-1111-4111-8111-111111111111",
	sceneId: "b1111111-1111-4111-8111-111111111111",
	locale: "ja",
	archived: false,
	title: "Forest scene",
	summary: "Trees and birds",
	startInSeconds: 10.5,
	endInSeconds: 25,
	catalogPreview: { kind: "HLS", url: "/media.m3u8", time: 10.5 },
};
const expectedHref =
	"/library/content?contentRevision=3&analysisRevisionId=a1111111-1111-4111-8111-111111111111&sceneId=b1111111-1111-4111-8111-111111111111&locale=ja&archived=false";

it.each([
	["en", "Relevance 87.5/100"],
	["ja", "関連度 87.5/100"],
] as const)("shows localized relevance alongside metadata while preserving the scene link (%s)", async (locale, label) => {
	renderLocalized(
		<LibrarySceneResults
			items={[
				{ ...hit, relevance: { score: 87.5, matchedTerms: 2, totalTerms: 2 } },
			]}
		/>,
		locale,
	);
	const link = screen.getByRole("link", { name: /Forest scene/ });
	expect(await within(link).findByText(label)).toHaveClass("tabular-nums");
	expect(link).toHaveAttribute("href", expectedHref);
	expect(link).toHaveTextContent("0:10–0:25");
	expect(link).toHaveTextContent("Nature film");
	expect(within(link).getByTestId("thumbnail")).toBeInTheDocument();
	expect(
		within(link).getByRole("heading", { name: "Forest scene" }),
	).toBeInTheDocument();
	expect(within(link).queryByRole("button")).not.toBeInTheDocument();
});

it("renders an older scoreless result without invented relevance or changed identity", async () => {
	renderLocalized(<LibrarySceneResults items={[hit]} />);
	const link = await screen.findByRole("link", { name: /Forest scene/ });
	expect(link).toHaveAttribute("href", expectedHref);
	expect(link).toHaveTextContent("Nature film");
	expect(within(link).queryByText(/Relevance|\/100/)).not.toBeInTheDocument();
});

it.each([
	[0, "Relevance 0.0/100"],
	[88, "Relevance 88.0/100"],
] as const)("shows an available integer score with one decimal (%s)", async (score, label) => {
	renderLocalized(
		<LibrarySceneResults
			items={[{ ...hit, relevance: { score, matchedTerms: 0, totalTerms: 2 } }]}
		/>,
	);
	expect(await screen.findByText(label)).toBeInTheDocument();
});
