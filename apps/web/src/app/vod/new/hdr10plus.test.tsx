import { encodingPlanSchema } from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	mergeWizardDraft,
	projectWizardDraft,
	readWizardDraft,
	writeWizardDraft,
} from "@/lib/wizard-draft";
import { renderWithQuery } from "@/test/render";
import { buildPlan, type WizardState } from "./build-plan";
import {
	collapseToFileOutput,
	FILE_OUTPUT_DEFAULT_STATE,
	fileOutputBlockers,
} from "./file-output";
import { FileOutputSection } from "./file-output-section";
import { parseImportedPlan } from "./plan-import";
import { evaluateWizardState } from "./plan-preview";
import { planToWizardState } from "./plan-to-wizard";
import { addVodVideo } from "./rendition-copy";
import { renditionSourceOptions } from "./rendition-sources";
import { SourcesSection } from "./sources-section";
import {
	blankStream,
	convertStreamType,
	flattenStreams,
	removeStream,
	writeStream,
} from "./stream-model";
import { LadderSection } from "./wizard-sections";

afterEach(() => localStorage.clear());

function validState(): WizardState {
	const value = structuredClone(FILE_OUTPUT_DEFAULT_STATE);
	value.name = "HDR10+ file";
	value.inputFiles[0] = {
		key: "main",
		inputKey: "main",
		kind: "S3",
		credentialId: "11111111-1111-4111-8111-111111111111",
		bucket: "input",
		path: "hdr10.mov",
	};
	value.output = {
		...value.output,
		credentialId: "11111111-1111-4111-8111-111111111111",
		bucket: "output",
		basePath: "hdr10plus/",
	};
	value.sources = {
		hdr10PlusStreams: [
			{
				key: "hdr-plus",
				videoInputFile: "main",
				metadataInputPath: "metadata/hdr10plus.json",
				selectionMode: "AUTO",
			},
		],
	};
	value.videos = value.videos.map((video) => ({
		...video,
		codec: "H265",
		h265: { dynamicRangeFormat: "HDR10", profile: "MAIN10" },
		extras: { ...video.extras, source: "hdr-plus" },
	}));
	return value;
}

function hdr10PlusSource(value: WizardState) {
	const source = value.sources?.hdr10PlusStreams?.[0];
	if (!source) throw new Error("Missing HDR10+ source");
	return source;
}

describe("HDR10+ source authoring", () => {
	it("keeps its type, literal path and optional position through stream edits", () => {
		const source = validState().sources;
		if (!source) throw new Error("Missing sources");
		const row = flattenStreams(source)[0];
		if (!row) throw new Error("Missing HDR10+ stream row");
		expect(row.type).toBe("HDR10_PLUS");
		expect(writeStream(source, row)).toEqual(source);
		const changed = writeStream(source, {
			...row,
			metadataInputPath: "metadata/new.json",
			selectionMode: "VIDEO_RELATIVE",
			position: 0,
		});
		expect(changed.hdr10PlusStreams?.[0]).toMatchObject({
			metadataInputPath: "metadata/new.json",
			position: 0,
		});
		expect(removeStream(source, row).hdr10PlusStreams).toEqual([]);
		const converted = convertStreamType(
			{
				tracks: [
					{
						key: "audio",
						inputFile: "main",
						selectionMode: "AUDIO_RELATIVE",
						position: 2,
					},
				],
			},
			{
				origin: "track",
				index: 0,
				key: "audio",
				type: "INGEST",
				inputFile: "main",
				selectionMode: "AUDIO_RELATIVE",
				position: 2,
			},
			"HDR10_PLUS",
		);
		expect(converted.hdr10PlusStreams?.[0]).toMatchObject({
			selectionMode: "AUTO",
		});
		expect(converted.hdr10PlusStreams?.[0]).not.toHaveProperty("position");
		expect(
			blankStream(
				{
					trimmingStreams: [
						{ kind: "TIME_BASED", key: "hdr10plus1", sourceKey: "video" },
					],
				},
				"HDR10_PLUS",
			).hdr10PlusStreams?.[0]?.key,
		).toBe("hdr10plus2");
	});

	it.each([
		"en",
		"ja",
	] as const)("edits and browses a JSON path without adding a media input in %s", (locale) => {
		const onBrowse = vi.fn();
		function Harness() {
			const [value, setValue] = useState(validState());
			return (
				<>
					<SourcesSection
						state={value}
						onPatch={(patch) =>
							setValue((previous) => ({ ...previous, ...patch }))
						}
						onBrowseHdr10PlusMetadata={onBrowse}
					/>
					<output data-testid="hdr-state">{JSON.stringify(value)}</output>
				</>
			);
		}
		renderWithQuery(<Harness />, locale);
		const path = screen.getByLabelText(
			locale === "ja"
				? "HDR10+ メタデータ JSON パス"
				: "HDR10+ metadata JSON path",
		);
		fireEvent.change(path, { target: { value: "metadata/edited.json" } });
		fireEvent.click(
			screen.getByRole("button", {
				name: locale === "ja" ? "ストレージを参照…" : "Browse storage…",
			}),
		);
		expect(onBrowse).toHaveBeenCalledWith("hdr-plus");
		const stateNow = () =>
			JSON.parse(
				screen.getByTestId("hdr-state").textContent ?? "{}",
			) as WizardState;
		expect(stateNow().inputFiles).toHaveLength(1);
		expect(stateNow().sources?.hdr10PlusStreams?.[0]?.metadataInputPath).toBe(
			"metadata/edited.json",
		);
		const mode = screen.getByLabelText(
			locale === "ja" ? "選択モード" : "Selection mode",
		);
		expect(
			Array.from((mode as HTMLSelectElement).options).map(
				(option) => option.value,
			),
		).not.toContain("AUDIO_RELATIVE");
		fireEvent.change(mode, { target: { value: "VIDEO_RELATIVE" } });
		const position = screen.getByLabelText(
			locale === "ja" ? "位置" : "Position",
		);
		expect(position).toHaveValue(null);
		fireEvent.change(position, { target: { value: "3" } });
		expect(stateNow().sources?.hdr10PlusStreams?.[0]?.position).toBe(3);
		fireEvent.change(mode, { target: { value: "AUTO" } });
		expect(stateNow().sources?.hdr10PlusStreams?.[0]).not.toHaveProperty(
			"position",
		);
	});

	it("offers HDR10+ to video renditions, never audio", () => {
		const options = renditionSourceOptions(validState(), (key) => key);
		expect(options.video.some((option) => option.value === "hdr-plus")).toBe(
			true,
		);
		expect(options.audio.some((option) => option.value === "hdr-plus")).toBe(
			false,
		);
	});

	it.each([
		"ladder",
		"file",
	] as const)("retains the selected HDR10+ source when choosing H.265 in the %s editor", (view) => {
		const initial = validState();
		initial.videos = initial.videos.map((video) => ({
			...video,
			codec: "H264",
			extras: { ...video.extras, source: undefined },
		}));
		function Harness() {
			const [value, setValue] = useState(initial);
			const patch = (partial: Partial<WizardState>) =>
				setValue((previous) => ({ ...previous, ...partial }));
			return (
				<>
					{view === "ladder" ? (
						<LadderSection state={value} credentials={[]} onPatch={patch} />
					) : (
						<FileOutputSection state={value} onPatch={patch} />
					)}
					<output data-testid="rendition-state">{JSON.stringify(value)}</output>
				</>
			);
		}
		renderWithQuery(<Harness />);
		const source = screen.getAllByLabelText(
			view === "ladder" ? "Source stream" : "Video source",
		)[0];
		if (!source) throw new Error("Missing video source control");
		expect(source.textContent).toMatch(/HDR10\+.*hdr10\.mov/);
		fireEvent.change(source, { target: { value: "hdr-plus" } });
		const codec = screen.getAllByLabelText("Codec")[0];
		if (!codec) throw new Error("Missing video codec control");
		fireEvent.change(codec, { target: { value: "H265" } });
		expect(source).toHaveValue("hdr-plus");
		const changed = JSON.parse(
			screen.getByTestId("rendition-state").textContent ?? "{}",
		) as WizardState;
		expect(changed.videos[0]).toMatchObject({
			codec: "H265",
			extras: { source: "hdr-plus" },
		});
		expect(changed.sources).toEqual(initial.sources);
		expect(buildPlan(changed).renditions[0]).toMatchObject({
			codec: "H265",
			ingestKey: "hdr-plus",
		});
	});

	it("retains sidecar intent through a draft, file view, rendition copy and plan import", () => {
		const original = validState();
		writeWizardDraft("hdr10plus", "vod", original, 1);
		const draft = readWizardDraft("hdr10plus", "vod");
		if (!draft) throw new Error("Missing HDR10+ draft");
		const restored = mergeWizardDraft(
			structuredClone(FILE_OUTPUT_DEFAULT_STATE),
			draft.value,
			"vod",
		);
		expect(restored.sources).toEqual(original.sources);
		expect(fileOutputBlockers(restored)).toEqual([]);
		const collapsed = collapseToFileOutput(restored);
		expect(collapsed.sources).toEqual(original.sources);
		const copied = { ...collapsed, ...addVodVideo(collapsed, 0) };
		expect(copied.videos.at(-1)?.extras?.source).toBe("hdr-plus");
		const plan = encodingPlanSchema.parse(buildPlan(copied));
		expect(
			encodingPlanSchema.parse(buildPlan(planToWizardState(plan))),
		).toEqual(plan);
		expect(evaluateWizardState(restored)).toMatchObject({ ok: true });
	});

	it("preserves invalid positions for correction and excludes URLs and arbitrary JSON from drafts", () => {
		const original = validState();
		hdr10PlusSource(original).position = -1;
		writeWizardDraft("invalid-hdr", "vod", original, 1);
		const draft = readWizardDraft("invalid-hdr", "vod");
		if (!draft) throw new Error("Missing invalid HDR10+ draft");
		const restored = mergeWizardDraft(
			structuredClone(FILE_OUTPUT_DEFAULT_STATE),
			draft.value,
			"vod",
		);
		expect(restored.sources?.hdr10PlusStreams?.[0]?.position).toBe(-1);
		const raw = buildPlan(restored);
		const imported = parseImportedPlan(JSON.stringify(raw));
		if (!imported.ok) throw new Error("Import did not retain raw plan");
		expect(imported.imported.raw).toEqual(raw);
		expect(imported.imported.evaluation.ok).toBe(false);
		const safe = projectWizardDraft("vod", {
			...original,
			sources: {
				hdr10PlusStreams: [
					{
						...hdr10PlusSource(original),
						metadataInputPath:
							"https://example.invalid/metadata.json?secret=SECRET",
						json: "SECRET_JSON",
					},
				],
			},
		});
		expect(JSON.stringify(safe)).not.toMatch(/SECRET|https:/);
	});
});
