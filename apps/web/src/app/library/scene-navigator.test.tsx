import { normalizeSceneAnalysis } from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import { SceneNavigator } from "./scene-navigator";

const scenes = normalizeSceneAnalysis({
	metadata: { version: "1" },
	duration: 41,
	scenes: Array.from({ length: 41 }, (_, i) => ({
		id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
		title: `Scene ${i}`,
		startInSeconds: i,
		endInSeconds: i + 1,
	})),
}).scenes;

function navigator(current: number, fresh = scenes) {
	return (
		<SceneNavigator scenes={fresh} currentSceneId={scenes[current]?.id}>
			{(visible) => (
				<ul>
					{visible.map((scene) => (
						<li key={scene.id}>{scene.title}</li>
					))}
				</ul>
			)}
		</SceneNavigator>
	);
}

it("follows playback page changes but retains manual browsing on a refreshed snapshot", () => {
	const view = renderLocalized(navigator(20));
	expect(screen.getByText("Page 2 of 3 · 41 scenes")).toBeVisible();
	expect(screen.getByText("Scene 20")).toBeVisible();
	fireEvent.click(screen.getByRole("button", { name: "Next" }));
	expect(screen.getByText("Scene 40")).toBeVisible();
	view.rerender(
		navigator(
			20,
			scenes.map((scene) => ({ ...scene })),
		),
	);
	expect(screen.getByText("Page 3 of 3 · 41 scenes")).toBeVisible();
	view.rerender(navigator(0));
	expect(screen.getByText("Scene 0")).toBeVisible();
	expect(screen.getByText("Page 1 of 3 · 41 scenes")).toBeVisible();
});

it("clears an empty search and resets bounded pagination", () => {
	renderLocalized(navigator(0));
	fireEvent.click(screen.getByRole("button", { name: "Next" }));
	fireEvent.change(screen.getByRole("searchbox"), {
		target: { value: "missing" },
	});
	expect(screen.getByText("No scenes match this search.")).toBeVisible();
	expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
	fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
	expect(screen.getAllByRole("listitem")).toHaveLength(20);
	expect(screen.getByText("Scene 0")).toBeVisible();
	expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
});
