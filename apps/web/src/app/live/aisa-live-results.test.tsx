import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AisaResultSnapshot } from "@/lib/aisa-live/contracts";
import { renderWithQuery } from "@/test/render";
import { AisaLiveResults } from "./aisa-live-results";

const snapshot: AisaResultSnapshot = {
	analysisId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
	encodingId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
	sequence: 1,
	producedAt: "2026-11-07T00:00:00Z",
	mediaTimeOriginUnixMs: 1794009600000,
	isFinal: true,
	analyzedStartTimeSeconds: 0,
	analyzedEndTimeSeconds: 20,
	metadata: { version: "synthetic", disclaimer: "Synthetic fixture" },
	sourceGaps: [],
	observations: [],
	keyMoments: [],
};
const props = {
	accountId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
	analysisId: snapshot.analysisId,
	encodingId: snapshot.encodingId,
	failed: false,
	acceptedSnapshot: snapshot,
};

describe("key moment result presentation", () => {
	it("preserves the standalone heading and visible snapshot diagnostics by default", () => {
		const rendered = renderWithQuery(<AisaLiveResults {...props} />);
		expect(screen.getByRole("heading", { name: "Key moments" })).toBeVisible();
		expect(screen.getByText("Snapshot 1")).toBeVisible();
		expect(screen.getByText("Analyzed: 0–20 s")).toBeVisible();
		expect(rendered.container.querySelector("details")).toBeNull();
	});

	it("embeds without another heading and groups technical metadata in a closed disclosure", () => {
		const rendered = renderWithQuery(
			<AisaLiveResults
				{...props}
				embedded
				technicalDetails={<p>Bound analysis metadata</p>}
			/>,
		);
		expect(screen.queryByRole("heading")).not.toBeInTheDocument();
		expect(screen.getByText("Final result")).toBeVisible();
		const disclosure = rendered.container.querySelector("details");
		expect(disclosure).not.toHaveAttribute("open");
		expect(
			screen.getByText("Analysis details", { selector: "summary" }),
		).toBeVisible();
		for (const text of [
			"Bound analysis metadata",
			"Snapshot 1",
			"Analyzed: 0–20 s",
		]) {
			expect(screen.getByText(text).closest("details")).toBe(disclosure);
			expect(screen.getByText(text)).not.toBeVisible();
		}
	});

	it("keeps finality and retained-source errors outside the technical disclosure", () => {
		renderWithQuery(
			<AisaLiveResults {...props} embedded failed rejectedUpdate />,
		);
		expect(screen.getByText("Final result")).toBeVisible();
		for (const alert of screen.getAllByRole("alert")) {
			expect(alert).toBeVisible();
			expect(alert.closest("details")).toBeNull();
		}
		expect(screen.getAllByRole("alert")).toHaveLength(2);
	});
});
