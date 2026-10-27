import { liveChannelPlanSchema, validateLiveChannel } from "@bitovp/core";
import { fireEvent, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { mergeWizardDraft, projectWizardDraft } from "@/lib/wizard-draft";
import { renderWithQuery } from "@/test/render";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
	type LiveWizardState,
} from "./build-live-plan";
import { LiveEncryptionSection } from "./encryption-section";
import { LiveFallbackRegions } from "./fallback-regions-section";
import { tryImportLiveChannelIntoWizard } from "./live-plan-to-wizard";
import { LiveManifestListSection } from "./manifest-list-section";

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn() }),
	useSearchParams: () => new URLSearchParams(),
}));
const credentialId = "00000000-0000-4000-8000-000000000003";
function state(): LiveWizardState {
	const s = structuredClone(DEFAULT_LIVE_WIZARD_STATE);
	s.name = "Encrypted Live";
	s.accountId = "00000000-0000-4000-8000-000000000001";
	s.output.credentialId = "00000000-0000-4000-8000-000000000002";
	s.output.bucket = "test";
	s.output.basePath = "live/encrypted";
	return s;
}
function encrypted(kind: "CENC" | "FAIRPLAY" | "SPEKE"): LiveWizardState {
	const s = state(),
		clear = buildLiveChannelPlan(s);
	s.cloudRegion = "AWS_US_EAST_1";
	s.drm = clear.muxings.map((m) => {
		if (!m.destination) throw new Error("destination missing");
		const common = {
			key: `${m.key}-${kind.toLowerCase()}`,
			muxingKey: m.key,
			credentialId,
			destination: m.destination,
		};
		return kind === "CENC"
			? {
					...common,
					kind,
					kid: "a".repeat(32),
					encryptionMode: "CBC",
					ivSize: "IV_16_BYTES",
					fairPlay: { iv: "b".repeat(32), uri: "skd://live" },
				}
			: kind === "FAIRPLAY"
				? { ...common, kind, iv: "b".repeat(32), uri: "skd://live" }
				: {
						...common,
						kind,
						systemIds: ["edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"],
					};
	});
	s.manifests.hls.drmKind = kind;
	s.manifests.dash.drmKind = kind;
	return s;
}

describe("unsupported Live fallback regions", () => {
	it.each([
		{ regions: undefined },
		{ regions: [] },
	])("shows no selector or notice for empty new forms (%j)", ({ regions }) => {
		const current = state();
		current.fallbackCloudRegions = regions;
		const patch = vi.fn();
		const { container } = renderWithQuery(
			<LiveFallbackRegions state={current} onPatch={patch} />,
		);
		expect(container).toBeEmptyDOMElement();
		expect(patch).not.toHaveBeenCalled();
	});

	it.each([
		[
			"en",
			"Live Encoding does not support fallback regions.",
			"Clear fallback regions",
		],
		[
			"ja",
			"Live Encodingでは代替リージョンを指定できません。",
			"代替リージョンを解除",
		],
	] as const)("preserves imported and draft values until explicitly cleared (%s)", (locale, notice, clearLabel) => {
		const initial = state();
		initial.cloudRegion = "AWS_US_EAST_1";
		initial.fallbackCloudRegions = ["AWS_US_WEST_2", "AUTO"];
		const saved = liveChannelPlanSchema.parse(buildLiveChannelPlan(initial));
		const imported = tryImportLiveChannelIntoWizard(saved);
		expect(imported.ok).toBe(true);
		if (!imported.ok) throw new Error(imported.reasonKey);
		expect(imported.state.fallbackCloudRegions).toEqual(
			initial.fallbackCloudRegions,
		);
		const restored = mergeWizardDraft(
			DEFAULT_LIVE_WIZARD_STATE,
			projectWizardDraft("live", imported.state),
			"live",
		);
		expect(restored.fallbackCloudRegions).toEqual(initial.fallbackCloudRegions);
		function Harness() {
			const [current, set] = useState(restored);
			return (
				<>
					<LiveFallbackRegions
						state={current}
						onPatch={(patch) => set({ ...current, ...patch })}
					/>
					<output data-testid="fallback-plan">
						{JSON.stringify(buildLiveChannelPlan(current))}
					</output>
				</>
			);
		}
		renderWithQuery(<Harness />, locale);
		expect(screen.getByRole("alert")).toHaveTextContent(notice);
		expect(
			within(screen.getByRole("alert")).getByText("AWS_US_WEST_2, AUTO"),
		).toBeVisible();
		expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
		const readPlan = () =>
			liveChannelPlanSchema.parse(
				JSON.parse(screen.getByTestId("fallback-plan").textContent ?? "{}"),
			);
		expect(readPlan().bitmovin.fallbackCloudRegions).toEqual(
			initial.fallbackCloudRegions,
		);
		expect(validateLiveChannel(readPlan())).toContainEqual(
			expect.objectContaining({ code: "LIVE_FALLBACK_REGIONS" }),
		);
		fireEvent.click(screen.getByRole("button", { name: clearLabel }));
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(readPlan().bitmovin.fallbackCloudRegions).toEqual([]);
		expect(readPlan().bitmovin.cloudRegion).toBe(initial.cloudRegion);
		expect(
			validateLiveChannel(readPlan()).filter(
				(issue) => issue.code === "LIVE_FALLBACK_REGIONS",
			),
		).toEqual([]);
	});
});

describe("Live encrypted plan form round trips", () => {
	for (const kind of ["CENC", "FAIRPLAY", "SPEKE"] as const)
		it(`${kind} survives plan import and draft restore without raw keys`, () => {
			const s = encrypted(kind),
				p = liveChannelPlanSchema.parse(buildLiveChannelPlan(s));
			const imported = tryImportLiveChannelIntoWizard(p);
			expect(imported.ok).toBe(true);
			if (!imported.ok) throw new Error(imported.reasonKey);
			expect(
				liveChannelPlanSchema.parse(buildLiveChannelPlan(imported.state)),
			).toEqual(p);
			const restored = mergeWizardDraft(
				DEFAULT_LIVE_WIZARD_STATE,
				projectWizardDraft("live", s),
				"live",
			);
			expect(restored.drm?.map((d) => d.credentialId)).toEqual(
				s.drm?.map((d) => d.credentialId),
			);
			expect(restored.fallbackCloudRegions).toEqual(s.fallbackCloudRegions);
			if (kind === "SPEKE")
				expect(
					liveChannelPlanSchema.parse(buildLiveChannelPlan(restored)),
				).toEqual(p);
			else expect(JSON.stringify(restored.drm)).not.toContain("skd://");
			expect(p.muxings.every((m) => !m.destination)).toBe(true);
			expect(
				JSON.stringify(
					projectWizardDraft("live", {
						...s,
						drm: s.drm?.map((d) => ({ ...d, secretKey: "never-save" })),
					}),
				),
			).not.toContain("never-save");
		});
	it("preserves optional clear outputs and independently configured encrypted folders", () => {
		const s = encrypted("FAIRPLAY");
		const first = s.drm?.[0];
		if (!first) throw new Error("DRM missing");
		first.destination = { ...first.destination, path: "encrypted/own-folder" };
		s.unencryptedMuxingKeys = [first.muxingKey];
		const p = liveChannelPlanSchema.parse(buildLiveChannelPlan(s));
		const imported = tryImportLiveChannelIntoWizard(p);
		expect(imported.ok).toBe(true);
		if (imported.ok)
			expect(
				liveChannelPlanSchema.parse(buildLiveChannelPlan(imported.state)),
			).toEqual(p);
	});
});
it("offers only legal encryption methods per container and copies public settings to every track", () => {
	const initial = encrypted("FAIRPLAY");
	function Harness() {
		const [s, set] = useState(initial);
		return (
			<>
				<LiveEncryptionSection
					state={s}
					credentials={[
						{
							id: credentialId,
							label: "Content key",
							provider: "DRM_CENC",
							config: {},
							hasSecret: true,
							createdAt: "2026-10-27T00:00:00.000Z",
							updatedAt: "2026-10-27T00:00:00.000Z",
						},
					]}
					onPatch={(p) => set({ ...s, ...p })}
				/>
				<output data-testid="plan">
					{JSON.stringify(buildLiveChannelPlan(s))}
				</output>
			</>
		);
	}
	renderWithQuery(<Harness />);
	expect(screen.getByText("Encryption")).toBeInTheDocument();
	expect(
		screen.getAllByRole("button", {
			name: "Copy encryption settings to all compatible tracks",
		}),
	).not.toHaveLength(0);
	fireEvent.change(
		screen.getAllByLabelText("IV (32 hex chars)")[0] as HTMLInputElement,
		{ target: { value: "c".repeat(32) } },
	);
	fireEvent.click(
		screen.getAllByRole("button", {
			name: "Copy encryption settings to all compatible tracks",
		})[0] as HTMLButtonElement,
	);
	const p = JSON.parse(screen.getByTestId("plan").textContent ?? "{}");
	expect(p.drm).toHaveLength(p.muxings.length);
	expect(p.drm.map((d: { iv: string }) => d.iv)).toEqual(
		p.muxings.map(() => "c".repeat(32)),
	);
	expect(
		validateLiveChannel(liveChannelPlanSchema.parse(p)).filter(
			(i) => i.level === "error",
		),
	).toEqual([]);
	expect(screen.queryByText(/key:/i)).not.toBeInTheDocument();
});
it("keeps an invalid imported fallback visible so validation can explain it", () => {
	const s = state();
	s.cloudRegion = "AWS_US_EAST_1";
	s.fallbackCloudRegions = ["GOOGLE_US_CENTRAL_1"];
	renderWithQuery(<LiveFallbackRegions state={s} onPatch={vi.fn()} />);
	expect(
		within(screen.getByRole("alert")).getByText("GOOGLE_US_CENTRAL_1"),
	).toBeVisible();
	expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
});
it("edits the encryption selector inside each Live manifest", () => {
	const s = encrypted("CENC"),
		patch = vi.fn();
	renderWithQuery(<LiveManifestListSection state={s} onPatch={patch} />);
	expect(
		screen
			.getAllByRole("combobox")
			.some((el) => (el as HTMLSelectElement).value === "CENC"),
	).toBe(true);
});

it.each([
	{},
	{ systemIds: undefined },
	{ systemIds: "invalid" },
	{ systemIds: [null] },
	{ destination: undefined },
	{ destination: "invalid" },
])("restores damaged SPEKE drafts without crashing metadata controls: %j", (damage) => {
	const source = encrypted("SPEKE");
	const first = source.drm?.[0];
	if (!first) throw new Error("Missing DRM");
	const saved = projectWizardDraft("live", {
		...source,
		drm: [{ ...first, ...damage }],
	});
	const restored = mergeWizardDraft(DEFAULT_LIVE_WIZARD_STATE, saved, "live");
	expect(() =>
		renderWithQuery(
			<LiveEncryptionSection
				state={restored}
				credentials={[]}
				onPatch={vi.fn()}
			/>,
		),
	).not.toThrow();
	expect(restored.drm?.[0]?.kind).toBe("SPEKE");
	if (restored.drm?.[0]?.kind === "SPEKE")
		expect(Array.isArray(restored.drm[0].systemIds)).toBe(true);
});
