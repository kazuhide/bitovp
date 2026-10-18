import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { messagesFor, translate } from ".";
import type { Translator } from "./context";
import {
	CUSTOM_DATA_TOO_LARGE,
	SENTENCE_TO_KEY,
	zodIssueMessage,
} from "./zod-issue-message";

/**
 * (c). Two halves:
 *  - behaviour of the choke point (authored map, dynamic extract, code map,
 *    VISIBLE fallback);
 *  - the TOTALITY pins that license the design's deviation (sentence→key
 *    lookup instead of key-emitting schemas): the coupling "reword a schema
 *    sentence and the mapping silently misses" is exactly what the
 *    source-reading test below turns into a build failure.
 */

const tFor = (locale: "en" | "ja"): Translator => {
	const messages = messagesFor(locale);
	return (key, values) => translate(messages, key, values);
};

describe("zodIssueMessage — the FORM-layer choke point", () => {
	it("maps an authored sentence to its ja catalogue entry", () => {
		const ja = zodIssueMessage(
			{ message: "A manual stream key must be at least 8 characters" },
			tFor("ja"),
		);
		expect(ja).toBe("手動ストリームキーは 8 文字以上にしてください");
	});

	it("keeps the EN rendering byte-identical to the authored sentence", () => {
		// EN catalogue entries are the sentences verbatim, so wiring the choke
		// point is a NO-OP for English users — the migration cannot reword.
		for (const [sentence] of SENTENCE_TO_KEY) {
			expect(zodIssueMessage({ message: sentence }, tFor("en"))).toBe(sentence);
		}
	});

	it("extracts the dynamic customData numbers into placeholders", () => {
		const raw = "customData is too large (12345 chars serialized; max 8192)";
		expect(CUSTOM_DATA_TOO_LARGE.test(raw)).toBe(true);
		expect(zodIssueMessage({ message: raw }, tFor("ja"))).toBe(
			"customData が大きすぎます(シリアライズ後 12345 文字。上限 8192 文字)",
		);
		expect(zodIssueMessage({ message: raw }, tFor("en"))).toBe(
			"customData is too large (12345 chars serialized; max 8192)",
		);
	});

	it("maps zod's own too_small on a string: min 1 reads as Required", () => {
		expect(
			zodIssueMessage(
				{
					code: "too_small",
					minimum: 1,
					origin: "string",
					message: "Too small: expected string to have >=1 characters",
				},
				tFor("ja"),
			),
		).toBe("必須です");
		expect(
			zodIssueMessage(
				{
					code: "too_small",
					minimum: 3,
					origin: "string",
					message: "Too small: expected string to have >=3 characters",
				},
				tFor("ja"),
			),
		).toBe("3 文字以上で入力してください");
	});

	it("maps too_big on a number through zTooBigNumber", () => {
		expect(
			zodIssueMessage(
				{
					code: "too_big",
					maximum: 100,
					origin: "number",
					message: "Too big: expected number to be <=100",
				},
				tFor("ja"),
			),
		).toBe("100 以下を指定してください");
	});

	it("arrays read as COUNTS, with a singular form at 1 (review-174 I1/N1)", () => {
		const one = {
			code: "too_small",
			minimum: 1,
			origin: "array",
			message: "Too small: expected array to have >=1 items",
		};
		expect(zodIssueMessage(one, tFor("en"))).toBe("Must have at least 1 item");
		expect(zodIssueMessage(one, tFor("ja"))).toBe("1 件以上必要です");
		const three = {
			...one,
			minimum: 3,
			message: "Too small: expected array to have >=3 items",
		};
		expect(zodIssueMessage(three, tFor("en"))).toBe(
			"Must have at least 3 items",
		);
	});

	it("array too_big reads as a count too", () => {
		expect(
			zodIssueMessage(
				{
					code: "too_big",
					maximum: 5,
					origin: "array",
					message: "Too big: expected array to have <=5 items",
				},
				tFor("ja"),
			),
		).toBe("5 件以内にしてください");
	});

	it("invalid_type carries zod's received tail (review-174 S4)", () => {
		const issue = {
			code: "invalid_type",
			expected: "object",
			message: "Invalid input: expected object, received undefined",
		};
		expect(zodIssueMessage(issue, tFor("ja"))).toContain(
			"受け取った値: undefined",
		);
		expect(zodIssueMessage(issue, tFor("en"))).toBe(
			"Invalid value (expected object, received undefined)",
		);
	});

	it("falls back to the RAW message VISIBLY for anything unknown", () => {
		const raw = "some validator sentence this module has never seen";
		expect(zodIssueMessage({ message: raw }, tFor("ja"))).toBe(raw);
		expect(zodIssueMessage({ code: "custom", message: raw }, tFor("ja"))).toBe(
			raw,
		);
	});
});

describe("totality — the pins that license the sentence→key deviation", () => {
	const libSchemaFiles = [
		join(__dirname, "../live-runtime/schemas.ts"),
		join(__dirname, "../infrastructure/schemas.ts"),
		// review-87b I-7: the watch rule schema — its name-charset sentence
		// rendered raw English in ja precisely because this list was
		// hardcoded to three files and nobody enrolled the fourth.
		join(__dirname, "../watch/schemas.ts"),
		join(__dirname, "../live-diagnostics/schemas.ts"),
	];
	const schemaSources = [
		...libSchemaFiles,
		// review-174 I2: credential-form (a wired site) parses CORE credential
		// schemas — 20 more authored sentences that rendered English in ja.
		join(__dirname, "../../../../../packages/core/src/credentials/schemas.ts"),
	].map((p) => readFileSync(p, "utf8"));

	it("the population is derived from disk, not from this file's memory", () => {
		// review-87b I-7's root cause was the LIST, not the sentence: a new
		// wired schemas.ts under lib/ never joined it. Walk lib/ and demand
		// every */schemas.ts is enrolled — a fifth module fails here.
		const libDir = join(__dirname, "..");
		const onDisk = readdirSync(libDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(libDir, entry.name, "schemas.ts"))
			.filter((p) => existsSync(p))
			.sort();
		expect(libSchemaFiles.slice().sort()).toEqual(onDisk);
	});

	it("every authored sentence in all enrolled schema files is in the table", () => {
		// The extraction mirrors how the sentences are authored: bare string
		// second-args to validators, and message: "..." props. A sentence
		// added or reworded in a schema without a table entry fails HERE, at
		// build time — not silently in a ja form.
		const validatorArg = new Set<string>();
		const messageProp = new Set<string>();
		for (const src of schemaSources) {
			for (const m of src.matchAll(
				/\.(?:min|max|refine|regex|length|url|email)\(\s*[^,)]*,\s*"([^"]+)"/g,
			)) {
				validatorArg.add(m[1] as string);
			}
			for (const m of src.matchAll(/message:\s*\n?\s*"([^"]+)"/g)) {
				messageProp.add(m[1] as string);
			}
		}
		const authored = new Set([...validatorArg, ...messageProp]);
		// EXACT counts per extraction route (review-174 S2: a >=floor lets one
		// regex silently die while the other keeps the total above water).
		// 7→11 / 53→57:  PR2 — liveScheduleArmSchema's four
		// cross-field custom messages (slate content/duration/account, and
		// content-fields-are-slate-only). Its fireAt datetime deliberately
		// carries NO custom message (zod's invalid_format code map translates;
		// an authored arg there is outside the validator alternation below).
		// 46→47 / 11→12 / 57→59:  (review-87b I-7 fold) — the watch
		// rule's name-charset regex arg and the template-token refine message
		// (object form deliberately: a refine's CALLBACK first arg contains
		// commas, so the bare-string alternation cannot see it).
		// 12→15 / 59→62:  — the OCI namespace/region anchors and
		// the GENERIC_S3 bare-hostname rail, all in message-object form for
		// the same reason (regex literals with {m,n} quantifiers carry a
		// comma the bare-string alternation stops at).
		// 47→48 : the Akamai MSL credential's stream-id rail.
		// Only ONE new sentence, not two — "Event name is required" was
		// already authored elsewhere and the set de-duplicates.
		expect(validatorArg.size).toBe(48);
		// 16→17 : the airAt START-only refusal — a message
		// PROPERTY (addIssue object form inside the arm schema's superRefine).
		// 17→18: the airAt-after-fireAt ordering refusal,
		// same route.
		// 18→21 : the auto-lead arm's three refusals —
		// fireAt-required-unless-derived, START-only, needs-airAt.
		// 21→22 : the AKAMAI_MSL Digest pair's both-or-neither
		// refine. A message PROPERTY because a `.refine` takes its message in
		// the object form — same route as the airAt refusals above.
		// 22→29 (2026-09-02, the AKAMAI_MSL edge base URL): seven refusals, one
		// per defect `parseCredentialEdgeBaseUrl` names, each an `addIssue`
		// message property inside the field's superRefine. The validator-arg
		// count does NOT move: the field has no bare-string validator arg.
		// 22→23 (C36, WP-A1): `insertableContentCreateSchema`'s exactly-one-of
		// inputs/source refine, object form. The preflight route's sibling
		// sentence lives in a route file, outside this population, and is
		// enrolled in the table by hand.
		// merge of origin/main into this branch (2026-09-03): both deltas above landed
		// together; the number is the instrument's received value on the merged tree.
		// Live diagnostics adds SRT-only filtering and credential-free HTTPS.
		// SPEKE DRM adds five distinct object-form schema refusals, measured here.
		expect(messageProp.size).toBe(37);
		// 62→63 (review-226 I3): the feeder manual-arm refusal. Measured.
		// 63→64 : the same one sentence — the totals move together
		// because it is a validator arg, which is what makes the two pins a
		// cross-check rather than two spellings of one number.
		// 64→65 : the airAt refusal joins through the
		// message-prop route above; both totals move together, as designed.
		// 65→66: the ordering refusal, same route again.
		// 66→69 : the three auto-lead refusals, all via the
		// message-prop route; both totals move together, as designed.
		// 69→70 : the Digest both-or-neither sentence, via the
		// message-prop route; both totals move together, as designed — which is
		// what makes these two pins a cross-check rather than one number twice.
		// 70→77 (2026-09-02): the seven edge base URL refusals, all via the
		// message-prop route; both totals move together, as designed.
		// 70→71 (C36, WP-A1): the inputs/source refine, via the message-prop
		// route; both totals move together, as designed.
		// merge of origin/main into this branch (2026-09-03): both deltas above landed
		// together; the number is the instrument's received value on the merged tree.
		expect(authored.size).toBe(85);
		const missing = [...authored].filter((s) => !SENTENCE_TO_KEY.has(s));
		expect(missing).toEqual([]);
	});

	it("the one template-literal sentence matches the dynamic pattern", () => {
		// infrastructure/schemas.ts builds it with ${...}; reconstruct the shape
		// and require the pattern to bite. If the schema's wording changes, this
		// fails rather than the message silently un-translating.
		const infra = schemaSources[1] as string;
		// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional — this matches the schema SOURCE text, not a template
		expect(infra).toContain("customData is too large (${serialized}");
		expect(
			CUSTOM_DATA_TOO_LARGE.test(
				"customData is too large (9001 chars serialized; max 8192)",
			),
		).toBe(true);
	});

	it("every table key resolves in BOTH locales, and ja is Japanese", () => {
		const en = messagesFor("en");
		const ja = messagesFor("ja");
		for (const [sentence, key] of SENTENCE_TO_KEY) {
			expect(translate(en, key)).toBe(sentence); // EN verbatim — the presets pattern
			const jaText = translate(ja, key);
			expect(jaText).not.toBe(sentence);
			expect(/[぀-ヿ一-鿿]/.test(jaText), key).toBe(true);
		}
	});
});

describe("caller totality — every production call site passes a translator", () => {
	it("no call to the four translator-taking builders omits the second arg", () => {
		// Review-174 R1: five of six callers were unpinned — and tsc cannot
		// catch an omitted OPTIONAL param, which is exactly how C1 shipped.
		// Source-reading, like the sentence-totality test: find every call in
		// non-test app code and require a second argument, scanning with a
		// balanced-paren walk (a naive regex dies on nested calls like
		// parseImportedPlan(JSON.stringify(x), t)).
		// The whole of src/ — a caller landing in components/ or lib/ must be
		// as visible as one in app/ (review-174 follow-up).
		const roots = [join(__dirname, "../..")];
		const offenders: string[] = [];
		const fnNames = [
			"evaluateWizardState(",
			"evaluateLiveWizardState(",
			"parseImportedPlan(",
			"parseImportedLivePlan(",
		];
		const files: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full);
				} else if (
					/\.(ts|tsx)$/.test(entry.name) &&
					!entry.name.includes(".test.")
				) {
					files.push(full);
				}
			}
		};
		for (const root of roots) {
			walk(root);
		}
		expect(files.length).toBeGreaterThan(50);
		let calls = 0;
		for (const file of files) {
			const src = readFileSync(file, "utf8");
			for (const fn of fnNames) {
				let idx = src.indexOf(fn);
				while (idx !== -1) {
					const before = src[idx - 1] ?? "";
					const isDefinition = /function\s$/.test(
						src.slice(Math.max(0, idx - 9), idx),
					);
					if (!isDefinition && !/[\w.]/.test(before)) {
						// Balanced walk to the call's closing paren. Braces and
						// brackets count too: a comma inside an inline object at
						// paren-depth 1 (evaluateWizardState({ ...state, x }))
						// is NOT an argument separator (review-174 follow-up —
						// their demonstrated survivor).
						let depth = 0;
						let braces = 0;
						let end = idx + fn.length - 1;
						let topLevelComma = false;
						for (let i = end; i < src.length; i++) {
							const ch = src[i];
							if (ch === "(") depth += 1;
							else if (ch === ")") {
								depth -= 1;
								if (depth === 0) {
									end = i;
									break;
								}
							} else if (ch === "{" || ch === "[") braces += 1;
							else if (ch === "}" || ch === "]") braces -= 1;
							else if (ch === "," && depth === 1 && braces === 0) {
								topLevelComma = true;
							}
						}
						calls += 1;
						if (!topLevelComma) {
							offenders.push(
								`${file.split("/apps/web/")[1] ?? file}: ${fn}…) passes no translator`,
							);
						}
					}
					idx = src.indexOf(fn, idx + 1);
				}
			}
		}
		// Six known call sites today; a NEW caller without a translator fails
		// here by name rather than shipping silent English.
		expect(calls).toBeGreaterThanOrEqual(6);
		expect(offenders).toEqual([]);
	});
});
