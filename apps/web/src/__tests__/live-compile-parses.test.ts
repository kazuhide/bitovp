import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "../../../..");

/**
 * Every compile of a live run parses its plan first — , F1's
 * smaller sibling (review of PR #316).
 *
 * WHAT THIS PROTECTS. `compileLiveRunStepLog` is the choke point all three
 * re-air/revive paths funnel through, and its `seq: 1` arm hands the plan
 * straight to `compileLiveChannel` with NO re-parse — only `seq >= 2` re-parses,
 * via `rebaseLivePlanForRun`. So for a first run, the guarantee that a plan is
 * schema-valid when it reaches the compiler lives entirely in the CALLERS.
 *
 * That guarantee is load-bearing well beyond MSL5. It is what makes
 * `AKAMAI_MSL_VERSIONS = ["MSL4"]` the effective refusal of an MSL5 plan now
 * that the pre-GA experimental gate is retired, and more generally it is why
 * `LiveChannelPlan`'s type can be trusted at the compiler: TypeScript's
 * structural typing accepts any object of the right shape, and a persisted
 * `channel.plan` is Prisma `Json` — one cast away from reaching the compiler
 * unvalidated.
 *
 * WHY IT NEEDS AN INSTRUMENT AT ALL. It had one, inside
 * `msl5-gate-wiring.test.ts` — `expect(sweepCalls).toHaveLength(2)` plus the
 * per-site assertions — and the gate retirement deleted that file whole. Four
 * of its five arms were about the gate; this axis and the version-universe one
 * were not, and both went with it. Same root cause both times: deleting a file
 * is a claim about every test in it.
 *
 * WHY FROM-DISK IS THE RIGHT SHAPE HERE, having argued the opposite elsewhere.
 * The version-universe guard was re-homed AWAY from a text pin because its
 * property is behavioural — what a schema accepts is observable at runtime, so
 * it can be set-equalled against the const. This property has **no runtime
 * surface at all**: "who calls this and did they parse first" cannot be
 * observed without executing every call site, including ones that do not exist
 * yet. That is a real difference between the two axes, not special pleading for
 * the instrument I happened to write. The repo calls this the emit-sites idiom
 * and keeps it for exactly this class.
 *
 * IT INHERITS THE WEAKNESS ANYWAY, and pretending otherwise is how the next
 * reader over-trusts it. A helper — `parseLivePlan(row.plan)` — reads as a
 * violation while being perfectly correct. The `\s*` inside the identifier
 * covers a formatter breaking the line; nothing covers a rename. So this guard
 * proves "the shapes I anticipated are safe", never "every shape is safe", and
 * its exemption list below is the seam where an unanticipated-but-correct shape
 * gets recorded instead of silently loosening the pattern.
 *
 * The instrument is built to fail LOUD on growth rather than silently cover
 * less: the file population is set-equalled, so a fourth call site anywhere is
 * red until someone decides about it, and the parse must sit in the ARGUMENT
 * POSITION, which no intervening code can bypass.
 */
describe("every live-run compile parses its plan first", () => {
	/** Tracked files only — an agent worktree under /tmp is not this repo. */
	const tracked = execFileSync("git", ["ls-files", "-z"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	})
		.split("\0")
		.filter((f) => /\.(ts|tsx)$/.test(f));

	const CALL = /compileLiveRunStepLog\(/g;

	/** Production call sites, by file → how many calls that file makes. */
	const callSites = new Map<string, number>();
	for (const rel of tracked) {
		if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) {
			continue;
		}
		const src = readFileSync(join(REPO_ROOT, rel), "utf8");
		// The definition itself is `export function compileLiveRunStepLog(`.
		const calls = [...src.matchAll(CALL)].filter(
			(m) =>
				!src.slice(Math.max(0, m.index - 24), m.index).includes("function"),
		);
		if (calls.length > 0) {
			callSites.set(rel, calls.length);
		}
	}

	/**
	 * The declared population. A new entry here is a DECISION — which is the
	 * whole point, because the alternative is a fourth site inheriting the
	 * guarantee silently and being wrong about it.
	 */
	const DECLARED = {
		"apps/web/src/app/api/live-channels/[id]/actions/route.ts": 1,
		"apps/worker/src/scheduler/sweep.ts": 2,
	} as const;

	it("nobody has added a compile site without deciding about it", () => {
		// Set equality both ways: a NEW site fails, and so does a site that
		// disappeared — a decaying floor (`>=`) would let coverage shrink to
		// nothing while staying green.
		expect(Object.fromEntries([...callSites.entries()].sort())).toEqual(
			DECLARED,
		);
	});

	/**
	 * Call sites allowed to pass an EXTRACTED parsed plan instead of parsing in
	 * the argument position. Key is `<file>#<0-based call index>`; the value is
	 * the reason, and it is read by a human, not by a regex.
	 *
	 * WHY THIS EXISTS AT ALL — review of #317, and the argument convinced me.
	 * Argument-position is a *sufficient* proof that the plan was parsed, not a
	 * *necessary* one. This is equally safe and strictly better:
	 *
	 *   const parsed = liveChannelPlanSchema.parse(channel.plan);
	 *   const compiled = compileLiveRunStepLog(parsed, runForCompile, { … });
	 *
	 * and it is not hypothetical: `actions/route.ts` parses the same row twice
	 * inside one transaction today — once hoisted for the profile check, once in
	 * the argument position here — precisely because this rule forbids the
	 * refactor that would merge them.
	 *
	 * A guard that forbids a correct refactor gets WEAKENED by the next person
	 * who needs one, under deadline, by loosening the regex. So the escape hatch
	 * is a list they edit and the next reader can read, rather than a pattern
	 * they edit and nobody reviews. Adding an entry is a decision with a name on
	 * it; loosening a regex is not.
	 *
	 * Empty today, deliberately: no call site currently needs it.
	 */
	const ARGUMENT_POSITION_EXEMPT: Record<string, string> = {};

	it.each(
		Object.keys(DECLARED),
	)("%s parses in the ARGUMENT POSITION at every call", (rel) => {
		const src = readFileSync(join(REPO_ROOT, rel), "utf8");
		const calls = [...src.matchAll(/compileLiveRunStepLog\(/g)];
		calls.forEach((call, i) => {
			if (ARGUMENT_POSITION_EXEMPT[`${rel}#${i}`]) {
				return;
			}
			// Whitespace only between the paren and the parse: the plan
			// argument IS the parser's return value, so no branch, no
			// cast and no earlier variable can route around it. A regex
			// that merely asked whether the file mentions the parse
			// somewhere would pass on a file that parses for one call and
			// not the other — which is the shape sweep.ts has, with two
			// (different branches, so its two are not redundant).
			//
			// `\s*` inside the identifier too, because a formatter may break
			// `liveChannelPlanSchema` and `.parse(` across lines and that is
			// not a violation of anything.
			const after = src.slice(call.index + call[0].length);
			expect(
				after,
				`${rel}: compileLiveRunStepLog call #${i} does not take a parsed plan.\n` +
					"Either parse in the argument position — compileLiveRunStepLog(liveChannelPlanSchema.parse(x), …) —\n" +
					"or, if you need the extracted-const shape (it is equally safe and often better),\n" +
					`add "${rel}#${i}" to ARGUMENT_POSITION_EXEMPT in this file with the reason.\n` +
					"Do NOT loosen this pattern: it is what makes 'no branch or cast routes around the parse' checkable.",
			).toMatch(/^\s*liveChannelPlanSchema\s*\.\s*parse\(/);
		});
	});

	it("every exemption names a call site that exists and gives a reason", () => {
		// An exemption for a call that no longer exists is a stale licence
		// nobody notices — the same class as the four unread arms that started
		// this whole thread. And a blank reason is an exemption with no author.
		for (const [key, reason] of Object.entries(ARGUMENT_POSITION_EXEMPT)) {
			const [rel, idx] = key.split("#");
			expect(
				Object.keys(DECLARED),
				`${key}: exempts a file that is not a declared call site`,
			).toContain(rel);
			const src = readFileSync(join(REPO_ROOT, rel as string), "utf8");
			const calls = [...src.matchAll(/compileLiveRunStepLog\(/g)];
			expect(
				calls.length,
				`${key}: exempts call #${idx}, but that file has ${calls.length}`,
			).toBeGreaterThan(Number(idx));
			expect(
				reason.trim().length,
				`${key}: exemption has no reason`,
			).toBeGreaterThan(20);
			// The point of the exemption is the EXTRACTED shape — so the file
			// had better still contain one, or the exemption is licensing
			// something else entirely.
			expect(src, `${key}: exempted, but nothing here parses a plan`).toMatch(
				/=\s*liveChannelPlanSchema\s*\.\s*parse\(/,
			);
		}
	});

	it("the seq:1 arm really is the one with no re-parse — the reason this file exists", () => {
		// If this stops being true (the choke starts parsing its own input),
		// this instrument becomes redundant rather than wrong — and whoever
		// makes that change should read this and delete the file deliberately,
		// which is why the premise is asserted rather than assumed.
		const src = readFileSync(
			join(REPO_ROOT, "packages/core/src/live/run-rebase.ts"),
			"utf8",
		);
		const body = src.slice(
			src.indexOf("export function compileLiveRunStepLog"),
		);
		const seq1 = body.indexOf(
			"return { entries: initStepLog(compileLiveChannel(plan))",
		);
		expect(
			seq1,
			"the seq:1 return moved — re-derive this file's premise",
		).toBeGreaterThan(-1);
	});
});
