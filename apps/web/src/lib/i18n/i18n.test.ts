import { describe, expect, it } from "vitest";
import {
	DEFAULT_LOCALE,
	isLocale,
	LOCALES,
	type Locale,
	messagesFor,
	resolveLocale,
	translate,
} from ".";
import { en } from "./messages/en";
import { ja } from "./messages/ja";

it("slate image copy says stills are admitted, with their caveats (row #329)", () => {
	for (const locale of ["ja", "en"] as const) {
		for (const key of [
			"customerError.slateUnsupportedImage",
			"feederError.slateImage",
			"contentInsertion.imageNotice",
			"contentInsertion.sourceFileHelp",
		] as const) {
			const copy = translate(messagesFor(locale), key);
			expect(copy).toContain(locale === "ja" ? "静止画" : "still");
			expect(copy).not.toMatch(
				/無効|実測済み|disabled|has been measured|until they are measured/,
			);
		}
	}
});

function leaves(node: unknown, prefix = ""): Map<string, string> {
	const out = new Map<string, string>();
	for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (typeof value === "string") {
			out.set(path, value);
		} else {
			for (const [k, v] of leaves(value, path)) {
				out.set(k, v);
			}
		}
	}
	return out;
}

/**
 * `satisfies Messages` already forces the two catalogues to share a key set, so
 * these assertions look redundant — they are not, and the distinction is the
 * reason this file exists.
 *
 * The type check proves the SHAPE. It cannot prove that a Japanese value is
 * actually Japanese: `ja.ts` full of English strings typechecks perfectly, and
 * that is the realistic failure — a key added to `en.ts`, copied into `ja.ts` to
 * make typecheck pass, and never translated. Nothing in the compiler notices.
 */
describe("catalogue parity", () => {
	const enLeaves = leaves(en);
	const jaLeaves = leaves(ja);

	it("has the same keys in both locales", () => {
		expect([...jaLeaves.keys()].sort()).toEqual([...enLeaves.keys()].sort());
	});

	it("has no empty strings", () => {
		for (const [locale, map] of [
			["en", enLeaves],
			["ja", jaLeaves],
		] as const) {
			for (const [key, value] of map) {
				expect(value.trim(), `${locale}.${key}`).not.toBe("");
			}
		}
	});

	/**
	 * The size of the two halves a manual read-through splits the catalogue into.
	 *
	 * STATUS #35 claims every Japanese value was read: the long ones sentence by
	 * sentence, the short ones as labels. Those figures were measured by an ad-hoc
	 * regex parser over `ja.ts`, and it silently skipped every value its pattern did
	 * not match — so it reported 1,219 and later 1,229 where the real population is
	 * 1,242. Review caught it arithmetically: the second number was not reachable from
	 * the first by the keys added in between.
	 *
	 * The fix is not a better number, it is computing it here, where the definition
	 * lives in code and a threshold change fails a test instead of staling a document.
	 * Update these deliberately; a drift of one is a value added or reworded.
	 */
	it("splits into the long and short halves STATUS reports", () => {
		const japanese = /[぀-ヿ㐀-䶿一-鿿]/;
		const values = [...jaLeaves.values()];
		// Spread, so an astral character counts once rather than as a surrogate pair.
		const long = values.filter((v) => [...v].length >= 26);
		const short = new Set(
			values.filter((v) => [...v].length < 26 && japanese.test(v)),
		);
		// review-292's fold-verification ask, adapted: printing the exact
		// entered/left sets needs a pre-edit baseline the repo does not store
		// (the reviewer diffed against a git checkout), but both drifts so far
		// were a 26-boundary crossing or a Set-dedup — so a mismatch prints
		// the boundary band and names those two causes, instead of leaving
		// the next author to re-litigate the comment by hand.
		const pinWithDriftAid = (
			actual: number,
			expected: number,
			label: string,
		) => {
			if (actual !== expected) {
				const band = values
					.filter((v) => Math.abs([...v].length - 26) <= 3)
					.map((v) => `${[...v].length}  ${v}`)
					.sort();
				console.error(
					`${label} pin drift (${actual} ≠ ${expected}). Re-derive by RUNNING this instrument — never hand-sum.\n` +
						"Usual causes: a reworded value crossed the 26-codepoint boundary, or the short Set deduplicated identical values.\n" +
						`Boundary band (23–29 codepoints):\n${band.join("\n")}`,
				);
			}
			expect(actual).toBe(expected);
		};
		/* Assert the measured number of unique long Japanese strings. Update the count only after inspecting the catalog change that crosses the length threshold. */
		// Imported catalogue: qc.mixedReferenceCanvases adds one long value.
		pinWithDriftAid(long.length, 1449, "long");
		/* Assert the measured number of unique short Japanese strings. Duplicate translations count once, including singular and plural keys with the same Japanese value. */
		// WebM missing-file labels add two distinct short Japanese values.
		pinWithDriftAid(short.size, 2809, "short");
	});

	/**
	 * The untranslated-copy check. Keys are exempted BY NAME rather than by a
	 * heuristic, so adding a key cannot silently join the exemption list: a new
	 * English-identical value fails until someone writes it down here with a
	 * reason.
	 */
	const IDENTICAL_ON_PURPOSE = new Set([
		"tenant.slug", // Short identifier label, used consistently in both locales.
		"tenant.ipPlaceholder", // Literal example IP addresses/CIDRs.
		// A product name. Translating it would be wrong, not merely unnecessary.
		"nav.brand",
		// #32 §6: `signedInAs` is a pure "{name} · {role}" format with no prose
		// to translate; the separator is locale-neutral. (The role-name keys
		// the first cut exempted were removed with review-286 MINOR 3 — the
		// UI renders the enum literals directly and the server-error refusals
		// stay English per §10b, so those keys were dead translations.)
		"nav.signedInAs",
		/* Resource kind and sequence number are locale-neutral placeholders. */
		"liveOutputs.manifestNumber",
		/* Keep the established DRM initialism consistent across credential groups and the rest of the application. */
		"settings.groupDrm",
		/* Preserve the Akamai MSL product name consistently across destination labels. */
		"live.destinationAkamaiMsl",
		/* Use the same DRM terminology in insights and credential views. */
		"insights.drm",
		/* Revision chips use the same revision token as template and job-detail copy. */
		"templates.revision",
		// "{from} → {to}" — pure interpolation, no words to translate; the
		// arrow is the same glyph in both catalogues .
		"runs.window",
		/* The frame-rate column uses the established fps unit. */
		"heartbeatLog.fps",
		/* The raw-data toggle names its JSON format consistently with export controls. */
		"heartbeatLog.rawToggle",
		/* Keep the QC feature name consistent between its column heading, routes and related screens. */
		"jobs.qc",
		/* Keep Webhook URL consistent with the external service and API terminology; localize the adjacent explanation. */
		"fields.webhookUrl",
		/* Preserve the Per-Title feature name used by the API, SDK and encoder dashboard. */
		"jobDetail.perTitle",
		// : the ladder-level mode radio reuses the same feature name.
		"wizard.modePerTitle",
		// `Muxing` is Bitmovin's resource name — the API type, the SDK class and this
		// app's own tables all call it that. The renditions table above already
		// exempts its own `colMuxings` column for the same reason; this is the
		// per-title results table's column of the same name.
		"jobDetail.ptColMuxing",
		/* Preserve the Dolby trademark and API tokens rather than introducing alternate spellings. */
		"jobDetail.chainDolby",
		/* Display each language endonym so readers can recognize the language-switcher option. */
		"locale.en",
		"locale.ja",
		// Preset-gallery family labels that ARE product/feature names or API
		// tokens: DRM, HDR10, "Dolby Vision & Atmos" (two trademarks), "AI Scene
		// Analysis" (Bitmovin's feature name) and Per-Title (same rationale as
		// jobDetail.perTitle above). The other seven families are prose and are
		// translated.
		"presetGallery.family.ai-scene-analysis",
		"presetGallery.family.dolby",
		"presetGallery.family.drm",
		"presetGallery.family.hdr10",
		"presetGallery.family.pertitle",
		// Two preset TITLES that consist entirely of identifiers — codec names,
		// feature names and product names with nothing to translate ("AI Scene
		// Analysis — per-title H264"; "Per-Title H264 → Smooth Streaming +
		// PlayReady"). Their DESCRIPTIONS are translated, and the totality test
		// separately requires every ja description to contain Japanese.
		"presetGallery.ai-scene-analysis-pertitle.title",
		"presetGallery.pertitle-h264-mp4-smooth-drm-on-aws.title",
		/* Keep the provider heartbeat resource name consistent with API payloads and logs. */
		"live.heartbeat",
		// A protocol name plus "URL". There is no Japanese form of either, and
		// RTMP URL is what the field is called everywhere else.
		"feeder.rtmpUrl",
		// EXAMPLE VALUES, not copy. A placeholder shows the shape of the input, so
		// translating it would misdescribe what to type. Kept as data.
		"feeder.rtmpUrlPlaceholder",
		"contentInsertion.namePlaceholder",
		"contentInsertion.inputPathPlaceholder",
		"liveToVod.manifestPathPlaceholder",
		"settings.ocid1CompartmentOc1",
		"settings.ocid1TenancyOc1",
		// A numeric range, and a Bitmovin product name. Neither has a Japanese form.
		"fields.k165535",
		"settings.cloudConnect",
		// The default encoder-version branch, spelled `main` in the API and in the
		// field this placeholder belongs to.
		"settings.main",
		// VOD wizard: SDK enum values, codec-tool acronyms, API field names, sample
		// values and filename patterns. Every one of these is a string the operator
		// also types into the API, reads in a step log, or copies from a sample —
		// a Japanese spelling would be a second name for one thing.
		"wizard.ai",
		"wizard.analysisJson",
		"wizard.cabac",
		"wizard.campaignAUhd",
		"wizard.dashStreamMpd",
		"wizard.demoChannelJp",
		"wizard.fairplayUri",
		"wizard.false",
		"wizard.hdr",
		"wizard.hlsStreamM3u8",
		"wizard.jpgJpegPng",
		"wizard.maxcll",
		"wizard.maxfall",
		"wizard.null",
		"wizard.playreadyLaUrl",
		"wizard.playreadyPssh",
		"wizard.psyRdo",
		"wizard.psyRdoq",
		"wizard.realObjectPathExt",
		"wizard.sao",
		"wizard.spriteJpg",
		"wizard.spriteVtt",
		"wizard.subMe",
		"wizard.templateYaml",
		"wizard.thumbnailNumberJpg",
		"wizard.true",
		"wizard.widevinePssh",
		// Protocol names, in both locales.
		"ui.rtmp",
		"ui.srt",
		// Ingest remains Latin; the neutral no-input state is localized.
		"status.ingest",
		// "3/8" — two numbers and a slash, with no word to translate.
		"uiX.stepsFraction",
		// Live wizard and the shared screens: SDK enum values, API field names,
		// protocol tokens, sample values, and metric labels an operator also reads
		// in a step log or a curl command.
		"ui.adinsertionsettingsEnableesammediapointinser",
		"ui.bitmovinAposS",
		"ui.bitmovinOvp",
		"ui.cacheControl",
		"ui.campaignAUhd",
		"ui.cbcIv16Bytes",
		"ui.ctrIv8Bytes",
		"ui.dagaaaaaaaaapWdwaa",
		"ui.dolbyDigital",
		"ui.dolbyDigital2",
		"ui.emsg",
		"ui.esamPoisScte250",
		"ui.extXDaterange",
		"ui.k128Aes128",
		"ui.k1Low",
		"ui.k256Aes256",
		"ui.movflagsFaststart",
		"ui.psnrDb",
		"ui.psnrDb2",
		"ui.publicMaxAge0NoCache",
		"ui.reschedule",
		"ui.rtmpEncoderIpLive",
		"ui.ts",
		"ui.zixi",
		"ui.zixiFeederExampleCom",
		/* Use the VOD product name consistently in both locales. */
		"usage.vod",
		"usage.liveUnits", // Bitmovin billing unit name, not a translated minute count.
		"qc.measurePsnr", // Standard metric acronym.
	]);

	it("translates every string that is not exempt", () => {
		const untranslated: string[] = [];
		for (const [key, value] of enLeaves) {
			if (IDENTICAL_ON_PURPOSE.has(key)) {
				continue;
			}
			if (jaLeaves.get(key) === value) {
				untranslated.push(key);
			}
		}
		expect(untranslated).toEqual([]);
	});

	it("exempts nothing that does not exist", () => {
		// Otherwise a renamed key leaves a stale exemption that hides its successor.
		for (const key of IDENTICAL_ON_PURPOSE) {
			expect(enLeaves.has(key), key).toBe(true);
		}
	});

	it("keeps every {placeholder} in the translation", () => {
		const placeholders = (value: string) =>
			[...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
		for (const [key, value] of enLeaves) {
			expect(placeholders(jaLeaves.get(key) as string), key).toEqual(
				placeholders(value),
			);
		}
	});
});

describe("resolveLocale", () => {
	const cases: [
		name: string,
		input: Parameters<typeof resolveLocale>[0],
		expected: Locale,
	][] = [
		["an explicit cookie", { cookie: "ja" }, "ja"],
		[
			"a cookie overriding the header",
			{ cookie: "en", acceptLanguage: "ja-JP,ja;q=0.9" },
			"en",
		],
		["a bogus cookie", { cookie: "klingon", acceptLanguage: "ja" }, "ja"],
		["an empty cookie", { cookie: "", acceptLanguage: "ja" }, "ja"],
		["a region-tagged header", { acceptLanguage: "ja-JP,en;q=0.8" }, "ja"],
		["an uppercase header", { acceptLanguage: "JA-JP" }, "ja"],
		["a header we do not ship", { acceptLanguage: "de-DE,fr;q=0.9" }, "en"],
		[
			"an unshipped language before a shipped one",
			{ acceptLanguage: "de,ja;q=0.5" },
			"ja",
		],
		["nothing at all", {}, "en"],
		["a null header", { acceptLanguage: null }, "en"],
		["whitespace and empty parts", { acceptLanguage: " , ,ja " }, "ja"],
		// `*` is a legal Accept-Language value and means "anything"; it must not
		// match a locale by accident.
		["a wildcard header", { acceptLanguage: "*" }, "en"],
		// q=0 means NOT ACCEPTABLE (RFC 9110 §12.5.4) — a different thing from a low
		// q, and honoured. Without this, `ja;q=0, en` served Japanese to a client
		// that had explicitly refused it while offering English in the same header.
		["ja refused outright", { acceptLanguage: "ja;q=0" }, "en"],
		["ja refused with en offered", { acceptLanguage: "ja;q=0, en" }, "en"],
		["en refused, ja offered", { acceptLanguage: "en;q=0, ja" }, "ja"],
		["both refused", { acceptLanguage: "ja;q=0, en;q=0" }, "en"],
		["q=0.0 spelled long", { acceptLanguage: "ja;q=0.0, en" }, "en"],
		["q=0 with spaces", { acceptLanguage: "ja ; q = 0 , en" }, "en"],
		// A very low q is still acceptable — only zero is a refusal.
		["a barely-acceptable q", { acceptLanguage: "ja;q=0.001" }, "ja"],
		// An unparsable q is treated as offered: a client typo must not silently
		// flip the page to another language.
		["a malformed q", { acceptLanguage: "ja;q=abc" }, "ja"],
		// Other parameters must not be mistaken for q.
		["a non-q parameter", { acceptLanguage: "ja;foo=0" }, "ja"],
	];

	for (const [name, input, expected] of cases) {
		it(`resolves ${name} to ${expected}`, () => {
			expect(resolveLocale(input)).toBe(expected);
		});
	}

	it("defaults to English", () => {
		expect(DEFAULT_LOCALE).toBe("en");
		expect(resolveLocale({})).toBe(DEFAULT_LOCALE);
	});
});

describe("isLocale", () => {
	it("accepts what we ship and nothing else", () => {
		for (const locale of LOCALES) {
			expect(isLocale(locale)).toBe(true);
		}
		for (const other of ["EN", "ja-JP", "", "de", null, undefined, 1, {}]) {
			expect(isLocale(other), String(other)).toBe(false);
		}
	});
});

describe("translate", () => {
	it("returns the string for a dotted key", () => {
		expect(translate(messagesFor("en"), "nav.settings")).toBe("Settings");
		expect(translate(messagesFor("ja"), "nav.settings")).toBe("設定");
	});

	it("interpolates {placeholders}", () => {
		const messages = { greet: "Hello {name}, {name} again" } as never;
		expect(translate(messages, "greet" as never, { name: "Kaz" })).toBe(
			"Hello Kaz, Kaz again",
		);
	});

	it("stringifies numbers", () => {
		const messages = { n: "{count} jobs" } as never;
		expect(translate(messages, "n" as never, { count: 3 })).toBe("3 jobs");
	});

	/**
	 * Throwing, not degrading. A missing key that renders as `nav.settings` looks
	 * like a styling bug and survives review; one that throws is found the first
	 * time the component renders.
	 */
	it("throws on a key that does not exist", () => {
		expect(() =>
			translate(messagesFor("en"), "nav.nope" as never),
		).toThrowError(/not a string/);
	});

	it("throws when a key names a whole section rather than a string", () => {
		expect(() => translate(messagesFor("en"), "nav" as never)).toThrowError(
			/not a string/,
		);
	});

	it("throws when a path walks through a string", () => {
		expect(() =>
			translate(messagesFor("en"), "nav.settings.deeper" as never),
		).toThrowError(/non-object/);
	});

	it("throws on a placeholder with no value supplied", () => {
		const messages = { greet: "Hello {name}" } as never;
		expect(() => translate(messages, "greet" as never, {})).toThrowError(
			/no value for \{name\}/,
		);
	});

	/**
	 * The form that actually ships. `useT`'s `t("key")` passes no `values`, and an
	 * early `if (!values) return node` meant this rendered `Hello {name}` verbatim
	 * to a user — the copy-shaped output the throw exists to prevent, asserted as
	 * impossible in three docs and in this function's own comment. Latent only
	 * because no catalogue string carries a placeholder yet, which is exactly why a
	 * test is worth more than fixing the sentence (review catch).
	 */
	it("throws on a placeholder when values is OMITTED, not just incomplete", () => {
		const messages = { greet: "Hello {name}" } as never;
		expect(() => translate(messages, "greet" as never)).toThrowError(
			/no value for \{name\}/,
		);
	});

	it("still returns placeholder-free strings with values omitted", () => {
		// The fix must not make the common case throw.
		expect(translate(messagesFor("en"), "nav.settings")).toBe("Settings");
	});

	/**
	 * Replaces the "no placeholder-bearing string yet" tripwire, which fired the
	 * moment the dashboard added `{total}` / `{stale}` / `{failed}` / `{count}` /
	 * `{time}` — exactly what it was written to do. Its job was to make the first
	 * placeholder loud; now that they exist, the useful assertion is that the safety
	 * net covers each one.
	 *
	 * Every placeholder-bearing key must THROW when called without values, so a call
	 * site that forgets them fails on first render instead of shipping `{total}` to
	 * a user. `values?.[name]` makes that true for the bare `t("key")` form too —
	 * that was a real bug before a review caught it.
	 */
	it("throws for every placeholder-bearing key when values are omitted", () => {
		const withPlaceholders = [...leaves(en)].filter(([, v]) =>
			/\{\w+\}/.test(v),
		);
		// Non-vacuous: the dashboard introduced these, so the list must not be empty.
		expect(withPlaceholders.length).toBeGreaterThan(0);
		for (const [key] of withPlaceholders) {
			expect(() => translate(messagesFor("en"), key as never)).toThrowError(
				/no value for/,
			);
			expect(() => translate(messagesFor("ja"), key as never)).toThrowError(
				/no value for/,
			);
		}
	});
});

describe("ledger #79's authored-English pass — ja values are Japanese", () => {
	it("every migrated tooltip/constant paragraph carries Japanese in ja", () => {
		const keys = [
			"qc.hintMean",
			"qc.hintHarmonicMean",
			"qc.hintLow1Percent",
			"qc.hintPercentiles",
			"qc.hintWorstFrame",
			"qc.hintMinMax",
			"qc.hintPsnr",
			"qc.hintAlignmentConfidence",
			"qc.hintLoopMap",
			"qc.hintFrameOffset",
			"uiX.dvrBudgetTooltip",
			"uiX.liveEdgeOffsetTooltip",
			// The two suffixes too — short, so the half-split pin also covers
			// them (they'd drop out of the short Set), but the list should match
			// the authored inventory (review-167 measured the overstated first
			// wording of this comment: for the 12 PARAGRAPHS this check is the
			// only one that catches lightly-edited English; for these two it is
			// one of two).
			"liveToVod.finishedAtSuffix",
			"liveToVod.refreshSuffix",
		];
		const japanese = /[぀-ヿ㐀-鿿]/;
		const lookup = (catalogue: Record<string, unknown>, dotted: string) =>
			dotted
				.split(".")
				.reduce<unknown>(
					(node, part) =>
						typeof node === "object" && node !== null
							? (node as Record<string, unknown>)[part]
							: undefined,
					catalogue,
				);
		const english = keys.filter(
			(key) => !japanese.test(String(lookup(ja, key))),
		);
		expect(english).toEqual([]);
	});
});
