import type { AnalysisJsonValue, ProviderAnalysisView } from "@bitovp/core";
import { normalizeSceneAnalysis } from "@bitovp/core";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import { AnalysisData, AnalysisHighlights } from "./analysis-data";

const document = normalizeSceneAnalysis({
	metadata: { version: "1" },
	duration: 10,
});
async function expand(text: string) {
	const summary = screen.getByText(text).closest("summary");
	if (!summary) throw new Error(`Missing summary ${text}`);
	fireEvent.click(summary);
	await waitFor(() => expect(summary.parentElement).toHaveAttribute("open"));
}
it("shows every field including future keys and exact falsy values without active HTML or links", async () => {
	const data = JSON.parse(
		'{"ratings":[{"region":"TEST","system":"Example","rating":"A"}],"future":{"zero":0,"disabled":false,"absent":null,"empty":"","object":{},"array":[],"__proto__":"literal key","html":"<img src=x onerror=alert(1)>","url":"https://example.test"}}',
	) as AnalysisJsonValue;
	const { container } = renderLocalized(
		<AnalysisData
			document={document}
			providerAnalysis={{ source: "PROVIDER", data }}
		/>,
	);
	expect(screen.queryByText("future")).not.toBeInTheDocument();
	await expand("All analysis fields");
	await expand("$");
	await expand("future");
	await screen.findByText("false");
	for (const value of [
		"0",
		"null",
		"Empty string",
		"Empty object {}",
		"Empty array []",
		"literal key",
		"<img src=x onerror=alert(1)>",
		"https://example.test",
	])
		expect(screen.getByText(value)).toBeInTheDocument();
	expect(screen.getByText("__proto__")).toBeInTheDocument();
	expect(container.querySelector("img, a")).toBeNull();
});
it("mounts collections lazily and exposes all entries in pages of 50", async () => {
	const data = { items: Array.from({ length: 120 }, (_, i) => `Item ${i}`) };
	renderLocalized(
		<AnalysisData
			document={document}
			providerAnalysis={{ source: "PROVIDER", data }}
		/>,
	);
	await expand("All analysis fields");
	await expand("$");
	await expand("items");
	await screen.findByText("Item 49");
	expect(screen.queryByText("Item 50")).not.toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: /Show next 50/ }));
	expect(screen.getByText("Item 99")).toBeInTheDocument();
	expect(screen.queryByText("Item 100")).not.toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: /Show next 50/ }));
	expect(screen.getByText("Item 119")).toBeInTheDocument();
	expect(
		screen.queryByRole("button", { name: /Show next 50/ }),
	).not.toBeInTheDocument();
});
it("labels normalized legacy fallback separately and shows common provider fields near the overview", async () => {
	const providerAnalysis: ProviderAnalysisView = {
		source: "PROVIDER",
		data: {
			inputLanguageCodes: ["ja"],
			ratings: [{ rating: "A" }],
			metadata: { disclaimer: "Review extracted values" },
		},
	};
	renderLocalized(
		<>
			<AnalysisHighlights providerAnalysis={providerAnalysis} />
			<AnalysisData document={document} />
		</>,
	);
	expect(screen.getByText("Input languages")).toBeInTheDocument();
	expect(screen.getByText("Content ratings")).toBeInTheDocument();
	expect(screen.getByText("Review extracted values")).toBeInTheDocument();
	await expand("All analysis fields");
	expect(
		screen.getByText("Stored normalized analysis (original unavailable)"),
	).toBeInTheDocument();
});
