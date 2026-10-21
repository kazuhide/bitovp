import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CREDENTIAL_PROVIDER_LABELS, CREDENTIAL_PROVIDERS } from "@bitovp/core";
import { fireEvent, render as rtlRender, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
// `renderWithQuery`, not `renderLocalized`: the credential picker now
// carries an "add a credential" link that invalidates the shared
// `["credentials"]` query on the operator's return (owner request
// 2026-08-19), and the app always renders inside a QueryClientProvider.
import { renderWithQuery as render } from "@/test/render";
import { DEFAULT_WIZARD_STATE, type WizardState } from "./build-plan";
import { InputFilesEditor, SourcesSection } from "./sources-section";
import { inputKindForProvider } from "./stream-model";
import { Collapsible } from "./wizard-fields";

const twoFileState: WizardState = {
	...DEFAULT_WIZARD_STATE,
	inputFiles: [
		{
			key: "main",
			inputKey: "main",
			kind: "S3",
			credentialId: "",
			bucket: "bucket-a",
			path: "video.mp4",
			name: "S3 Input",
		},
		{
			key: "in2",
			inputKey: "in2",
			kind: "S3",
			credentialId: "",
			bucket: "bucket-b",
			path: "audio.wav",
		},
	],
};

const noop = () => {};

describe("InputFilesEditor", () => {
	it("updates the region for every file sharing one GCS input resource", () => {
		const onPatch = vi.fn();
		const state: WizardState = {
			...twoFileState,
			inputFiles: twoFileState.inputFiles.map((file) => ({
				...file,
				kind: "GCS",
				inputKey: "shared",
				region: "ASIA_EAST_1",
			})),
		};
		const { container } = render(
			<InputFilesEditor
				state={state}
				credentials={[]}
				onPatch={onPatch}
				onBrowse={noop}
			/>,
		);
		const field = container.querySelector<HTMLSelectElement>(
			"#wz-file-1-gcs-region",
		);
		expect(field).not.toBeNull();
		expect(field?.tagName).toBe("SELECT");
		fireEvent.change(field as HTMLSelectElement, {
			target: { value: "EUROPE_WEST_1" },
		});
		expect(
			onPatch.mock.calls[0]?.[0].inputFiles.map(
				(file: { region?: string }) => file.region,
			),
		).toEqual(["EUROPE_WEST_1", "EUROPE_WEST_1"]);
	});
	it("makes the first input file the required primary — no remove control", () => {
		render(
			<InputFilesEditor
				state={twoFileState}
				credentials={[]}
				onPatch={noop}
				onBrowse={noop}
			/>,
		);
		// The primary is labelled and cannot be removed: deleting inputFiles[0]
		// would break the inputFiles[0] assumption across build-plan / stream-model
		// / plan-preview, so the affordance must not exist.
		expect(
			screen.getByText("Input file 1 — primary (required)"),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Remove input file 1" }),
		).not.toBeInTheDocument();
		// Additional files stay removable.
		expect(
			screen.getByRole("button", { name: "Remove input file 2" }),
		).toBeInTheDocument();
	});

	it("does not render the removed optional Name field", () => {
		render(
			<InputFilesEditor
				state={twoFileState}
				credentials={[]}
				onPatch={noop}
				onBrowse={noop}
			/>,
		);
		expect(screen.queryByLabelText("Name (optional)")).not.toBeInTheDocument();
	});

	it("removes a non-primary file, leaving the primary intact", async () => {
		const { default: userEvent } = await import("@testing-library/user-event");
		const user = userEvent.setup();
		const onPatch = vi.fn();
		render(
			<InputFilesEditor
				state={twoFileState}
				credentials={[]}
				onPatch={onPatch}
				onBrowse={noop}
			/>,
		);
		await user.click(
			screen.getByRole("button", { name: "Remove input file 2" }),
		);
		expect(onPatch).toHaveBeenCalledWith({
			inputFiles: [twoFileState.inputFiles[0]],
		});
	});

	it("appends a fresh, collision-free input file on Add", async () => {
		const { default: userEvent } = await import("@testing-library/user-event");
		const user = userEvent.setup();
		const onPatch = vi.fn();
		render(
			<InputFilesEditor
				state={twoFileState}
				credentials={[]}
				onPatch={onPatch}
				onBrowse={noop}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Add input file" }));
		const arg = onPatch.mock.calls[0]?.[0] as Partial<WizardState>;
		expect(arg.inputFiles).toHaveLength(3);
		expect(arg.inputFiles?.[2]).toMatchObject({
			kind: "S3",
			credentialId: "",
			bucket: "",
			path: "",
		});
		// Fresh key never collides with an existing one (in2 is taken → in3).
		expect(["main", "in2"]).not.toContain(arg.inputFiles?.[2]?.key);
	});

	it("browses by absolute input-file index (primary = 0)", async () => {
		const { default: userEvent } = await import("@testing-library/user-event");
		const user = userEvent.setup();
		const onBrowse = vi.fn();
		render(
			<InputFilesEditor
				state={twoFileState}
				credentials={[]}
				onPatch={noop}
				onBrowse={onBrowse}
			/>,
		);
		// S3 rows expose a Browse button; the primary must browse as index 0.
		const browse = screen.getAllByRole("button", { name: /browse/i });
		await user.click(browse[0] as HTMLElement);
		expect(onBrowse).toHaveBeenCalledWith(0);
	});

	it("opens the picker the moment a browsable credential is chosen — no extra Browse click (owner request 2026-09-06)", async () => {
		const { default: userEvent } = await import("@testing-library/user-event");
		const user = userEvent.setup();
		const onBrowse = vi.fn();
		const s3 = { id: "c-s3", label: "cred-s3", provider: "AWS_S3" };
		render(
			<InputFilesEditor
				state={twoFileState}
				credentials={[s3] as never}
				onPatch={noop}
				onBrowse={onBrowse}
			/>,
		);
		const selects = screen.getAllByRole("combobox");
		// the second file's credential select: browsing must name index 1
		await user.selectOptions(selects[selects.length - 1] as HTMLElement, s3.id);
		expect(onBrowse).toHaveBeenCalledWith(1);
		// back to the placeholder: nothing to browse
		onBrowse.mockClear();
		await user.selectOptions(selects[selects.length - 1] as HTMLElement, "");
		expect(onBrowse).not.toHaveBeenCalled();
	});
});

/**
 * Sources step in Japanese. `Input files ({n})` is interpolated, so reaching the
 * assertion at all proves the count was passed — `translate` throws on an unfilled
 * placeholder rather than rendering "{count}".
 */
describe("InputFilesEditor — Japanese", () => {
	it("renders the section heading, count and storage-kind options in Japanese", () => {
		render(
			<InputFilesEditor
				state={twoFileState}
				credentials={[]}
				onPatch={vi.fn()}
				onBrowse={vi.fn()}
			/>,
			"ja",
		);
		expect(screen.getByText("入力ファイル(2)")).toBeInTheDocument();
		// Row 1 is the required primary, so its header carries that role.
		expect(
			screen.getByText("入力ファイル 1(主ファイル・必須)"),
		).toBeInTheDocument();
		expect(screen.getByText("入力ファイル 2")).toBeInTheDocument();
		expect(screen.queryByText(/Input files/)).not.toBeInTheDocument();
	});
});

describe("the source is chosen by CREDENTIAL, not by storage kind (owner 2026-08-20)", () => {
	/**
	 * The step used to ask for the storage KIND first and then narrow the
	 * credential list. The dependency runs one way — a credential always
	 * determines its kind, a kind never determines a credential (`GENERIC_S3`
	 * covers Akamai, OCI and plain S3-compatible) — so the first question asked
	 * for strictly less than the second and had to be answered again. The
	 * OUTPUT step already derived the kind from the credential; the source step
	 * was the odd one out.
	 */
	/**
	 * Every input-capable provider PLUS three that are not.
	 *
	 * The first version filtered to input-capable only, so no option was ever
	 * `disabled` and the `!o.disabled` clause could fail only on
	 * OVER-disabling — under-disabling, which is the direction that offers a
	 * Kantar login as a video source, was invisible to it (review-147).
	 */
	const NOT_STORAGE = ["KANTAR", "DRM_CENC", "NOTIFICATION_WEBHOOK"] as const;
	const CREDS = [
		...CREDENTIAL_PROVIDERS.filter((p) => inputKindForProvider(p) !== null),
		...NOT_STORAGE,
	].map((p, i) => ({
		id: `c${i}`,
		// NOT `cred-${p}`: a label containing the provider enum makes the
		// "no raw enum on screen" assertion below measure the fixture instead
		// of the component. It failed for that reason first.
		label: `cred-${i}`,
		provider: p,
		config: {},
		createdAt: "",
		updatedAt: "",
	}));

	function sourceSelect(): HTMLSelectElement {
		render(
			<InputFilesEditor
				state={twoFileState}
				credentials={CREDS as never}
				onPatch={noop}
				onBrowse={noop}
			/>,
		);
		return screen.getAllByLabelText(/credential/i)[0] as HTMLSelectElement;
	}

	it("offers EVERY provider that maps to an input kind — derived, not a hand list", () => {
		// The list this replaces was hand-maintained, and review-8 caught it
		// missing Akamai NetStorage: the commit that added the input kind
		// explained why a customer would need it and then did not add it to the
		// list, so its own reason was unreachable from the form. Deriving the
		// population removes that failure mode rather than fixing one instance.
		// SELECTABLE, not merely present: unusable providers are rendered
		// `disabled`, so asserting the text exists calls a greyed-out option
		// "reachable". Narrowing the filter to AWS_S3 alone survived the first
		// version of this assertion.
		const options = [...sourceSelect().options];
		const missing = CREDS.filter(
			(c) => inputKindForProvider(c.provider) !== null,
		)
			.filter(
				(c) => !options.some((o) => o.text.includes(c.label) && !o.disabled),
			)
			.map((c) => c.provider);
		expect(missing, "these are unreachable as an input").toEqual([]);
	});

	it("names each credential's provider, so the derived kind is visible", () => {
		// The kind is no longer chosen, so the credential has to say what it is.
		// It used to render the raw enum — "(AKAMAI_OBJECT_STORAGE)" — which is
		// a wire value, and not what the credentials screen calls it.
		const options = [...sourceSelect().options].map((o) => o.text);
		expect(options.some((t) => t.includes("Akamai Object Storage"))).toBe(true);
		expect(options.some((t) => t.includes("AKAMAI_OBJECT_STORAGE"))).toBe(
			false,
		);
	});

	it("keeps HTTPS reachable, under a heading that does not call it a credential", () => {
		// The one input with no credential. Folding it into the same select is
		// what let the second control go away; putting it in a plain option
		// would have implied it is one.
		const select = sourceSelect();
		const https = [...select.querySelectorAll("optgroup")].find((g) =>
			g.querySelector("option")?.textContent?.match(/HTTPS/i),
		);
		expect(https, "HTTPS is not reachable").toBeTruthy();
		expect(https?.label).toMatch(/credential|資格情報/i);
	});

	it("no longer asks for the storage kind", () => {
		render(
			<InputFilesEditor
				state={twoFileState}
				credentials={CREDS as never}
				onPatch={noop}
				onBrowse={noop}
			/>,
		);
		expect(screen.queryByLabelText(/input storage/i)).toBeNull();
	});

	it("does NOT offer a non-storage credential as a video source", async () => {
		// The direction the original fixture could not test: every credential in
		// it was input-capable, so nothing was ever disabled and dropping the
		// `disabled` attribute entirely survived the whole suite (review-147).
		const options = [...sourceSelect().options];
		for (const provider of NOT_STORAGE) {
			const option = options.find((o) =>
				o.text.includes(CREDENTIAL_PROVIDER_LABELS[provider]),
			);
			expect(option, `${provider} is not even listed`).toBeTruthy();
			expect(option?.disabled, `${provider} is selectable as a source`).toBe(
				true,
			);
		}
	});

	it("picking HTTPS clears the bucket and path the previous kind left behind", async () => {
		// `bucket` IS the HTTPS host (`inputLocationLabel` says "Host",
		// `build-plan.ts` emits `host: f.bucket`). Leaving "bucket-a" behind
		// builds a schema-VALID plan pointing at a host that does not exist —
		// so the clearing is load-bearing, and nothing pinned it (review-147).
		const onPatch = vi.fn();
		render(
			<InputFilesEditor
				state={twoFileState}
				credentials={CREDS as never}
				onPatch={onPatch}
				onBrowse={noop}
			/>,
		);
		const select = screen.getAllByLabelText(
			/credential/i,
		)[0] as HTMLSelectElement;
		await userEvent.selectOptions(select, "__https__");
		expect(onPatch).toHaveBeenCalledWith(
			expect.objectContaining({
				inputFiles: expect.arrayContaining([
					expect.objectContaining({
						kind: "HTTPS",
						credentialId: "",
						bucket: "",
						path: "",
					}),
				]),
			}),
		);
	});

	it("can be cleared back to nothing chosen", async () => {
		/**
		 * review-147, CRITICAL: the `kind === null` guard written for unmapped
		 * providers swallowed the empty placeholder value too, so an operator
		 * who picked the wrong credential had no way back — the select snapped
		 * to the previous pick and nothing was patched.
		 *
		 * ONE row, credential set, location EMPTY. The first version of this
		 * test used `twoFileState` with a credential added to row 0 — and a row
		 * with credential AND location is `summary`, which renders no select at
		 * all, so `getAllByLabelText(…)[0]` drove ROW 1, whose credential was
		 * already "". It cleared an empty row and asserted only that some patch
		 * happened. `patchFile(i, {})` survived it.
		 *
		 * The trap is worth naming: the state change that makes the test
		 * meaningful — giving the row a credential — is the same change that
		 * removes the control it drives.
		 */
		const onPatch = vi.fn();
		const oneRow: WizardState = {
			...DEFAULT_WIZARD_STATE,
			inputFiles: [
				{
					key: "main",
					inputKey: "main",
					kind: "S3",
					credentialId: "c0",
					bucket: "",
					path: "",
				},
			],
		};
		render(
			<InputFilesEditor
				state={oneRow}
				credentials={CREDS as never}
				onPatch={onPatch}
				onBrowse={noop}
			/>,
		);
		// SINGULAR: it throws on ambiguity, which is the property the `[0]`
		// version lacked — there it silently picked a different row.
		const select = screen.getByLabelText(/credential/i) as HTMLSelectElement;
		// Fails loudly if this row ever slips into summary mode again.
		expect(select.value).toBe("c0");
		await userEvent.selectOptions(select, "");
		// Indexed, not `arrayContaining`: with two rows the container matcher
		// also passes on the OTHER row's already-empty credential.
		expect(onPatch.mock.calls[0]?.[0]?.inputFiles?.[0]?.credentialId).toBe("");
	});

	it("shows the source control on a FRESH row, not just a Browse button", async () => {
		// review-147: the storage-KIND select used to sit outside
		// `StorageLocation` and was the always-visible part. Deleting it left a
		// fresh row (DEFAULT_WIZARD_STATE — empty bucket and path) collapsed to
		// Browse + a grey "Enter manually" link, with every credential AND
		// HTTPS hidden behind a link that reads as "type the bucket by hand".
		render(
			<InputFilesEditor
				state={DEFAULT_WIZARD_STATE}
				credentials={CREDS as never}
				onPatch={noop}
				onBrowse={noop}
			/>,
		);
		const select = screen.getAllByLabelText(
			/credential/i,
		)[0] as HTMLSelectElement;
		expect(select).toBeTruthy();
		expect(
			[...select.options].some((o) => /HTTPS/i.test(o.text)),
			"HTTPS is not reachable on the state the operator lands on",
		).toBe(true);
	});

	it("refuses an unmapped provider even if the disabled attribute is bypassed", async () => {
		// Defence in depth, and the pair matters: the guard and the `disabled`
		// attribute protect the same thing from opposite sides, and review-147
		// showed they could rot together while the suite stayed green. A change
		// event carrying a disabled option's value is how a programmatic path
		// (or a future refactor that drops `disabled`) would reach it.
		const onPatch = vi.fn();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		render(
			<InputFilesEditor
				state={twoFileState}
				credentials={CREDS as never}
				onPatch={onPatch}
				onBrowse={noop}
			/>,
		);
		const select = screen.getAllByLabelText(
			/credential/i,
		)[0] as HTMLSelectElement;
		const kantar = [...select.options].find((o) =>
			o.text.includes(CREDENTIAL_PROVIDER_LABELS.KANTAR),
		);
		fireEvent.change(select, { target: { value: kantar?.value } });
		// No patch — and it SAYS so, rather than failing silently.
		expect(onPatch).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("not selectable as a source"),
		);
		warn.mockRestore();
	});
});

describe("the section's explanation lives behind a ?, not on the page (ledger #129)", () => {
	/* Contextual explanations belong in an accessible help overlay beside the relevant section heading. */
	const PROSE =
		/入力ファイルごとに、ジョブが読み込むオブジェクトの認証情報・バケット・パスを指定します/;

	function renderJa() {
		render(
			<InputFilesEditor
				state={twoFileState}
				credentials={[]}
				onPatch={noop}
				onBrowse={noop}
			/>,
			"ja",
		);
	}

	it("does not show the explanation until it is asked for", () => {
		renderJa();
		expect(screen.queryByText(PROSE)).toBeNull();
	});

	it("shows it on CLICK of the help mark beside the heading", async () => {
		renderJa();
		/* Identify the help trigger by its complete accessible name because the add-input button shares the section wording. */
		const help = screen.getByRole("button", { name: "「入力ファイル」の説明" });
		await userEvent.click(help);
		expect(screen.getByText(PROSE)).toBeInTheDocument();
	});

	it("closes again, so the prose does not become permanent", async () => {
		renderJa();
		const help = screen.getByRole("button", { name: "「入力ファイル」の説明" });
		await userEvent.click(help);
		await userEvent.click(help);
		expect(screen.queryByText(PROSE)).toBeNull();
	});

	it("leaves the STATE-DEPENDENT notes on the page — they are not manual prose", () => {
		/**
		 * The other half of "convert all of them": two paragraphs in this file
		 * are NOT always-on and must stay visible.
		 *
		 *   `wizardX.noExtraOptionsFor`  — only when the row type has no options
		 *   `wizard.implicitAudioReads…` — only when the implicit audio pair is
		 *                                  in use, inside the card about it
		 *
		 * Hiding a message that appears BECAUSE of the current state is the
		 * regression this whole change could have caused: an operator would
		 * have to know to click a ? to learn why the thing in front of them
		 * looks the way it does. I measured the file's population three times
		 * app-wide and got it wrong every time, so this pins the boundary
		 * rather than trusting that I drew it correctly.
		 */
		// `usesImplicitAudio` is "some audio rendition has no explicit source",
		// so the state has to say that — I first wrote it by clearing the
		// SOURCES, which is a different field and left the condition false.
		const withImplicitAudio: WizardState = {
			...DEFAULT_WIZARD_STATE,
			audios: [
				{
					...(DEFAULT_WIZARD_STATE.audios[0] as WizardState["audios"][number]),
					extras: {},
				},
			],
		};
		render(
			// `SourcesSection`, not the name I guessed. The component that owns
			// `usesImplicitAudio` is the one at line 528; there is no
			// `StreamsEditor` export, and React's "Element type is invalid"
			// was the only thing that said so.
			<SourcesSection state={withImplicitAudio} onPatch={noop} />,
			"ja",
		);
		// Rendered directly, not behind a ?, because it explains the state the
		// operator is looking at right now.
		expect(
			screen.getByText(
				/音声を個別に指定しない場合は、映像と同じオブジェクトから読み込みます/,
			),
		).toBeInTheDocument();
	});

	it("every collapsible section that EXPLAINS something carries it behind a ?", () => {
		/* Derive section coverage from the source definitions so a missing rendered section cannot remove its own test expectation. */
		const source = readFileSync(join(__dirname, "sources-section.tsx"), "utf8");
		const sites = [...source.matchAll(/<Collapsible\b([\s\S]*?)>/g)].map(
			(m) => m[1] ?? "",
		);
		expect(sites.length, "no Collapsible call sites parsed").toBe(7);

		/** Sections with no explanation to give, each with the reason. */
		const NOTHING_TO_EXPLAIN = [
			// A per-row "advanced" disclosure: the FIELDS inside carry their own
			// help . A section-level note
			// would repeat them.
			"wizard.advanced",
			"wizard.advancedPaddingAspect",
		];
		const missing = sites
			.filter((props) => !props.includes("help={"))
			.filter((props) => !NOTHING_TO_EXPLAIN.some((k) => props.includes(k)))
			.map((props) => props.trim().slice(0, 60));
		expect(
			missing,
			"these sections have no help — add one, or list them with a reason",
		).toEqual([]);

		// And the exemptions must still exist, or they hide the next section.
		for (const key of NOTHING_TO_EXPLAIN) {
			expect(
				sites.some((props) => props.includes(key)),
				`${key} is exempt but no longer a Collapsible`,
			).toBe(true);
		}
	});
});

describe("concatenation padding UNIT is a control, not a constant (ledger #149)", () => {
	/**
	 * The schema carried SECONDS|FRAMES from the start; the form hardcoded
	 * `unit: "SECONDS"` on every duration edit, so FRAMES was unreachable from
	 * any form — the enum-reachability sweep's finding. Two directions pinned:
	 * the select WRITES the unit, and a later duration edit PRESERVES it (the
	 * old code would have silently reset FRAMES back to SECONDS).
	 */
	const concatState: WizardState = {
		...DEFAULT_WIZARD_STATE,
		sources: {
			ingest: [
				{ key: "in-a", inputPath: "a.mp4" },
				{ key: "in-b", inputPath: "b.mp4" },
			],
			fileStreams: [],
			dolbyStreams: [],
			concatenationStreams: [
				{
					key: "concat",
					sources: [
						{
							sourceKey: "in-a",
							isMain: true,
							position: 0,
							paddingAfter: { duration: 2, unit: "SECONDS" },
						},
						{ sourceKey: "in-b", position: 1 },
					],
				},
			],
		} as WizardState["sources"],
	};

	it("flipping the unit select patches FRAMES into the state", async () => {
		const onPatch = vi.fn();
		render(<SourcesSection state={concatState} onPatch={onPatch} />);
		const selects = screen
			.getAllByLabelText(/unit/i)
			.filter((el): el is HTMLSelectElement => el instanceof HTMLSelectElement)
			.filter((el) => [...el.options].some((o) => o.value === "FRAMES"));
		expect(selects.length).toBeGreaterThan(0);
		const enabled = selects.find((el) => !el.disabled);
		expect(enabled, "no enabled unit select on the padded source").toBeTruthy();
		if (!enabled) return;
		await userEvent.selectOptions(enabled, "FRAMES");
		const patched = onPatch.mock.calls.at(-1)?.[0] as {
			sources?: {
				concatenationStreams?: {
					sources: { paddingAfter?: { unit?: string } }[];
				}[];
			};
		};
		expect(
			patched.sources?.concatenationStreams?.[0]?.sources[0]?.paddingAfter
				?.unit,
		).toBe("FRAMES");
	});

	it("editing the duration keeps FRAMES instead of resetting it", async () => {
		const framesState = structuredClone(concatState);
		const src = (
			framesState.sources as {
				concatenationStreams: {
					sources: { paddingAfter?: { duration: number; unit?: string } }[];
				}[];
			}
		).concatenationStreams[0]?.sources[0];
		if (src?.paddingAfter) src.paddingAfter.unit = "FRAMES";
		const onPatch = vi.fn();
		render(
			<SourcesSection state={framesState as WizardState} onPatch={onPatch} />,
		);
		const input = screen
			.getAllByLabelText(/padding after/i)
			.find((el): el is HTMLInputElement => el instanceof HTMLInputElement);
		expect(input).toBeTruthy();
		if (!input) return;
		await userEvent.type(input, "5");
		const patched = onPatch.mock.calls.at(-1)?.[0] as {
			sources?: {
				concatenationStreams?: {
					sources: { paddingAfter?: { unit?: string } }[];
				}[];
			};
		};
		expect(
			patched.sources?.concatenationStreams?.[0]?.sources[0]?.paddingAfter
				?.unit,
			"a duration edit silently reset the unit — the exact old behaviour",
		).toBe("FRAMES");
	});
});

describe("Collapsible is presentational — no LocaleProvider required (review-129 F7)", () => {
	/**
	 * It briefly called `useT` unconditionally to build the help trigger's
	 * label, and `lib/i18n/context.tsx` throws by design outside the provider.
	 * That is a hard dependency taken at all 38 `<Collapsible>` call sites for
	 * a prop 33 of them never pass. `HelpOverlay` interpolates its own label
	 * now, so the interpolation lives where `t` already is.
	 *
	 * Rendered WITHOUT the provider on purpose — inside one, the regression is
	 * invisible.
	 */
	it("renders with no help, outside any provider", () => {
		const { container } = rtlRender(
			<Collapsible summary="plain">body</Collapsible>,
		);
		expect(container.querySelector("summary")?.textContent).toBe("plain");
	});
});
