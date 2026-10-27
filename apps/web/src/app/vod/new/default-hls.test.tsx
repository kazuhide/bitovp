import {
	compileExpectedArtefacts,
	encodingPlanSchema,
	validatePlan,
} from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
	type WizardState,
} from "./build-plan";
import { ManifestSection } from "./wizard-sections";

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Fixture value missing");
	return value;
}

function fresh(): WizardState {
	return {
		...structuredClone(DEFAULT_WIZARD_STATE),
		name: "Default HLS test",
		inputFiles: [
			{
				key: "main",
				inputKey: "main",
				kind: "S3",
				bucket: "sample-input",
				path: "clip.mp4",
				credentialId: "00000000-0000-4000-8000-000000000001",
			},
		],
		output: {
			kind: "S3",
			bucket: "sample-output",
			basePath: "out/",
			publicRead: true,
			credentialId: "00000000-0000-4000-8000-000000000002",
			name: "Output",
		},
	};
}
function Harness({ initial = fresh() }: { initial?: WizardState }) {
	const [state, setState] = useState(initial);
	return (
		<>
			<ManifestSection
				state={state}
				onPatch={(patch) => setState((before) => ({ ...before, ...patch }))}
			/>
			<output data-testid="plan">{JSON.stringify(buildPlan(state))}</output>
		</>
	);
}
function plan() {
	return encodingPlanSchema.parse(
		JSON.parse(screen.getByTestId("plan").textContent ?? "{}"),
	);
}

describe("Default HLS wizard selection", () => {
	it("reports media outside the Default HLS parent without moving saved paths or an independent manual manifest", async () => {
		const initial = fresh();
		initial.output.basePath = "asset/manifests/";
		initial.videos[0] = {
			...required(initial.videos[0]),
			muxing: { path: "../video/" },
		};
		initial.audios[0] = {
			...required(initial.audios[0]),
			muxing: { path: "../audio/" },
		};
		initial.manifests.extra = [
			{ kind: "HLS", key: "manual", manifestName: "manual.m3u8" },
		];
		const before = buildPlan(initial);
		renderLocalized(<Harness initial={initial} />);
		await userEvent.click(
			required(screen.getAllByText("Additional manifest options")[0]),
		);
		fireEvent.change(await screen.findByLabelText("Manifest generation"), {
			target: { value: "DEFAULT" },
		});
		const result = plan();
		expect(result.manifests[0]?.destination.path).toBe("asset/manifests/");
		expect(result.muxings.map((row) => row.destination?.path)).toEqual(
			before.muxings.map((row) => row.destination?.path),
		);
		expect(
			result.manifests.find((row) => row.key === "manual")?.destination.path,
		).toBe("asset/manifests/");
		expect(
			validatePlan(result).filter(
				(issue) => issue.code === "PLAN_DEFAULT_HLS_OUTPUT_PATH",
			),
		).toMatchObject([{ level: "error" }]);
		expect(
			await screen.findByLabelText("Manifest generation"),
		).toHaveAccessibleDescription(/same directory as, or a parent of/);
	});
	it("keeps a valid custom parent when Default HLS is selected", async () => {
		const initial = fresh();
		initial.output.basePath = "asset/custom/";
		renderLocalized(<Harness initial={initial} />);
		await userEvent.click(screen.getByText("Additional manifest options"));
		fireEvent.change(await screen.findByLabelText("Manifest generation"), {
			target: { value: "DEFAULT" },
		});
		expect(plan().manifests[0]?.destination.path).toBe("asset/custom/");
	});
	it.each([
		"en",
		"ja",
	] as const)("%s: a fresh wizard can select Default HLS and build a valid plan", async (locale) => {
		renderLocalized(<Harness />, locale);
		await userEvent.click(
			screen.getByText(
				locale === "en"
					? "Additional manifest options"
					: "マニフェストの詳細設定",
			),
		);
		fireEvent.change(
			await screen.findByLabelText(
				locale === "en" ? "Manifest generation" : "生成方法",
			),
			{ target: { value: "DEFAULT" } },
		);
		const result = plan();
		expect(result.manifests[0]).toMatchObject({
			kind: "HLS",
			generationMode: "DEFAULT",
		});
		expect(result.generation.timing).toBe("POST_ENCODING");
		expect(
			validatePlan(result).filter((issue) => issue.level === "error"),
		).toEqual([]);
		expect(result.renditions.every((row) => row.hlsMedia === undefined)).toBe(
			true,
		);
		expect(
			compileExpectedArtefacts(result).manifests[0]?.hlsDefault,
		).toBeDefined();
	});
	it("prevents selecting Default when it would discard unused manual rendition names", async () => {
		const initial = fresh();
		initial.videos[0] = {
			...required(initial.videos[0]),
			extras: { hlsVariantUri: "my-video.m3u8" },
		};
		renderLocalized(<Harness initial={initial} />);
		await userEvent.click(screen.getByText("Additional manifest options"));
		const selector = await screen.findByLabelText("Manifest generation");
		expect(
			screen.getByRole("option", { name: "Default API (after encoding)" }),
		).toBeDisabled();
		fireEvent.change(selector, { target: { value: "DEFAULT" } });
		expect(plan().manifests[0]).not.toMatchObject({
			generationMode: "DEFAULT",
		});
		expect(plan().renditions[0]?.hlsVariantUri).toBe("my-video.m3u8");
		expect(selector).toHaveAccessibleDescription(
			/Remove those settings, keep manual generation/,
		);
	});
	it("retains shared custom names when another manual HLS manifest uses them", async () => {
		const initial = fresh();
		initial.videos[0] = {
			...required(initial.videos[0]),
			extras: { hlsVariantUri: "my-video.m3u8" },
		};
		initial.audios[0] = {
			...required(initial.audios[0]),
			extras: {
				hlsMedia: {
					groupId: "custom",
					name: "Saved audio",
					uri: "my-audio.m3u8",
				},
			},
		};
		initial.manifests.extra = [
			{ kind: "HLS", key: "manual", manifestName: "manual.m3u8" },
		];
		renderLocalized(<Harness initial={initial} />);
		const groups = screen.getAllByText("Additional manifest options");
		await userEvent.click(required(groups[0]));
		fireEvent.change(await screen.findByLabelText("Manifest generation"), {
			target: { value: "DEFAULT" },
		});
		const result = plan();
		expect(
			validatePlan(result).filter((issue) => issue.level === "error"),
		).toEqual([]);
		expect(result.renditions[0]?.hlsVariantUri).toBe("my-video.m3u8");
		expect(result.renditions[1]?.hlsMedia).toMatchObject({
			name: "Saved audio",
			uri: "my-audio.m3u8",
		});
		const expected = compileExpectedArtefacts(result);
		expect(expected.manifests[0]?.hlsDefault).toBeDefined();
		expect(
			expected.manifests.find((row) => row.manifestKey === "manual")
				?.hlsChildFiles,
		).toContain("my-video.m3u8");
	});
});
