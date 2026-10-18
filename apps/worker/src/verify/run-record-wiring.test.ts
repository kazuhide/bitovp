import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppPrismaClient } from "@bitovp/db";
import { afterEach, describe, expect, it } from "vitest";
import { runVerification } from "./runner";

/**
 * The runner's DURABLE-EVIDENCE call sites (re-audit HIGH-7 / GO 11).
 *
 * `run-record.test.ts` drives every decision the recorder makes. What is left
 * is the failure this repo has recorded twice — a rule that exists and a caller
 * that does not use it. Two of the five call sites can be reached for real,
 * because they fire before the runner needs a product or a bucket: the
 * RESERVATION and the INCOMPLETE mark. Those get behavioural arms. The three
 * that only fire mid-corpus (per-scenario outcome, cleanup, seal) need a
 * database, credentials, a running product and an encoder, so they are pinned
 * by shape and ORDER, the same instrument harness-rails.test.ts uses for the
 * refusals it cannot invoke.
 */

const RUNNER_SRC = await readFile(
	new URL("./runner.ts", import.meta.url),
	"utf8",
);

const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

async function runDir(): Promise<string> {
	const base = await mkdtemp(join(tmpdir(), "bitovp-verify-record-"));
	dirs.push(base);
	return join(base, "run");
}

type Captured = {
	creates: Record<string, unknown>[];
	updates: Record<string, unknown>[];
};

function fakePrisma(options: { duplicate?: boolean }): {
	prisma: AppPrismaClient;
	captured: Captured;
} {
	const captured: Captured = { creates: [], updates: [] };
	const prisma = {
		verificationRun: {
			create: async ({ data }: { data: Record<string, unknown> }) => {
				captured.creates.push(data);
				if (options.duplicate) {
					throw Object.assign(new Error("Unique constraint failed"), {
						code: "P2002",
					});
				}
				return { id: "row-1", recoveryGeneration: 0 };
			},
			update: async ({ data }: { data: Record<string, unknown> }) => {
				captured.updates.push(data);
				return { id: "row-1" };
			},
			updateMany: async ({ data }: { data: Record<string, unknown> }) => {
				captured.updates.push(data);
				return { count: 1 };
			},
		},
		// preflight's first act is to list credentials. Failing it stops the run
		// immediately AFTER the reservation and BEFORE anything is spent, which
		// is the exact window the INCOMPLETE mark exists for.
		credential: {
			findMany: async () => {
				throw new Error("preflight could not reach the database");
			},
		},
	} as unknown as AppPrismaClient;
	return { prisma, captured };
}

function config(prisma: AppPrismaClient, dir: string) {
	return {
		prisma,
		baseUrl: "http://127.0.0.1:3100",
		s3CredentialLabel: "verify-s3",
		inputBucket: "verify-in",
		outputBucket: "verify-out",
		sourceObject: "bbb-short.mov",
		runDir: dir,
		runId: "2026-08-29T10-00-00-000-abcdef",
		ffprobePath: "ffprobe",
		concurrency: 1,
		perScenarioTimeoutMs: 1000,
		log: () => {},
	};
}

describe("runVerification reserves its run id in the database", () => {
	it("creates the RUNNING row before preflight touches anything", async () => {
		const { prisma, captured } = fakePrisma({});
		await expect(
			runVerification(config(prisma, await runDir())),
		).rejects.toThrow();
		expect(captured.creates).toHaveLength(1);
		expect(captured.creates[0]).toMatchObject({
			runId: "2026-08-29T10-00-00-000-abcdef",
			baseUrlOrigin: "http://127.0.0.1:3100",
			sourceObject: "bbb-short.mov",
		});
		expect(String(captured.creates[0]?.reportPath)).toMatch(/report\.json$/);
	});

	/**
	 * GO 4: `prepareRunDir` refuses a reused id on ONE host's disk. Two hosts
	 * sharing a database do not share a filesystem, so the unique column is
	 * what makes the reservation atomic across them.
	 */
	it("REFUSES the run when another host already holds the id, and writes nothing else", async () => {
		const { prisma, captured } = fakePrisma({ duplicate: true });
		await expect(
			runVerification(config(prisma, await runDir())),
		).rejects.toThrow(/already reserved in the database/);
		expect(captured.updates).toEqual([]);
	});

	it("marks the row INCOMPLETE when the run throws before it seals", async () => {
		const { prisma, captured } = fakePrisma({});
		await expect(
			runVerification(config(prisma, await runDir())),
		).rejects.toThrow();
		const last = captured.updates.at(-1);
		expect(last).toMatchObject({ status: "INCOMPLETE" });
		expect(String(last?.error).length).toBeGreaterThan(0);
		expect(last?.finishedAt).toBeInstanceOf(Date);
	});
});

/**
 * The recorder's P2002 branch is an answer to a constraint the DATABASE has to
 * carry. Without the unique index the create simply succeeds twice and the
 * refusal never fires — a guard whose precondition lives in another file, so
 * this asserts the precondition rather than assuming it. No Postgres is
 * available here; the migration is the closest thing to the deployed schema
 * that can be read.
 */
describe("the reservation's uniqueness lives in the schema, not only in the handler", () => {
	const dbDir = new URL("../../../../packages/db/prisma/", import.meta.url);

	it("declares runId unique in the datamodel", async () => {
		const schema = await readFile(new URL("schema.prisma", dbDir), "utf8");
		const model = schema.slice(schema.indexOf("model VerificationRun {"));
		expect(model.slice(0, model.indexOf("\n}"))).toMatch(
			/runId\s+String\s+@unique/,
		);
	});

	it("creates the unique index in the migration that ships it", async () => {
		const sql = await readFile(
			new URL(
				"migrations/20260829120000_verification_run/migration.sql",
				dbDir,
			),
			"utf8",
		);
		expect(sql).toMatch(
			/CREATE UNIQUE INDEX "VerificationRun_runId_key" ON "VerificationRun"\("runId"\)/,
		);
		// SetNull, not Cascade: deleting an account must not delete the
		// evidence of what it was billed for.
		expect(sql).toMatch(
			/REFERENCES "BitmovinAccount"\("id"\) ON DELETE SET NULL/,
		);
	});
});

describe("the mid-corpus call sites, pinned by shape and order", () => {
	const body = RUNNER_SRC.slice(
		RUNNER_SRC.indexOf("async function runVerificationRecorded("),
	);
	const at = (needle: string) => {
		const index = body.indexOf(needle);
		expect(index, needle).toBeGreaterThan(-1);
		return index;
	};

	it("reserves AFTER the run directory is claimed and BEFORE preflight", () => {
		expect(at("await recorder.reserve({")).toBeGreaterThan(
			at("await prepareRunDir(config.runDir, {"),
		);
		expect(at("await recorder.reserve({")).toBeLessThan(
			at("await preflight({"),
		);
	});

	it("passes the exact reserved parent generation into the paid-intent ledger", () => {
		expect(body).toContain("const producerFence = recorder.producerFence()");
		expect(body).toContain(
			"producerRecoveryGeneration: producerFence.recoveryGeneration",
		);
	});

	it("records the fingerprint context before the first scenario can spend", () => {
		expect(at("await recorder.context({")).toBeGreaterThan(
			at("const fingerprint = await collectRunFingerprint(config.prisma)"),
		);
		expect(at("await recorder.context({")).toBeLessThan(
			at("const runOne = async ("),
		);
	});

	it("writes every outcome as the pool yields it, not once at the end", () => {
		const pool = body.slice(at("const outcomes = await pooled("));
		expect(pool.slice(0, pool.indexOf("});"))).toContain(
			"await recorder.outcome(outcome)",
		);
	});

	it("records EVERY ending that reads the provider, through one recorder call", () => {
		/**
		 * `ensureTerminal` now runs on BOTH endings of `runOne` — the abandoned
		 * job, and the job whose local row went terminal but not FINISHED (PR
		 * #337 review). Each one reads the provider, so each one must record it:
		 * a FAIL whose sibling encoding is still billing is precisely the row a
		 * release reader has to find afterwards. Every `ensureTerminal` call
		 * site is enumerated from the source, so a THIRD ending cannot be added
		 * without either recording its readback or failing here.
		 */
		const sites = [...body.matchAll(/await ensureTerminal\(\{/g)].map(
			(m) => m.index as number,
		);
		// Four since the response-loss canary: the run-level intent teardown
		// drives a VOD job adopted by its key, the canary mismatch safety path
		// reads the extra candidate, and both normal scenario endings remain.
		expect(sites.length).toBe(4);
		for (const site of sites) {
			expect(body.slice(site, site + 700)).toMatch(
				/await recordCleanup\((s\.name|row\.scenario), \w+(\.\w+)?, (cleanup|mismatched)\)/,
			);
		}
	});

	it("hands the recorder the whole ensureTerminal result, provider statuses included", () => {
		const helper = body.slice(at("const recordCleanup = ("));
		const call = helper.slice(0, helper.indexOf("const runOne = async ("));
		for (const field of [
			"status: cleanup.status",
			"cancelHttp: cleanup.cancelHttp",
			"terminal: cleanup.terminal",
			"localTerminal: cleanup.localTerminal",
			"providerTerminal: cleanup.providerTerminal",
			"provider: cleanup.provider",
		]) {
			expect(call, field).toContain(field);
		}
	});

	it("seals the row from the same bytes staged for recoverable export", () => {
		const markdown = at("const reportMarkdown =");
		const markdownDigest = body.indexOf(
			'reportMarkdownSha256: createHash("sha256")',
			markdown,
		);
		const finalJson = body.indexOf("reportJson = `", markdownDigest);
		const seal = at("const seal = sealReport(reportJson,");
		expect(markdown).toBeGreaterThan(-1);
		expect(markdownDigest).toBeGreaterThan(markdown);
		expect(finalJson).toBeGreaterThan(markdownDigest);
		expect(seal).toBeGreaterThan(finalJson);
		expect(body.slice(finalJson, seal)).toContain("JSON.stringify(report");
		const publish = at("await publishSealedRunReport({");
		expect(publish).toBeGreaterThan(seal);
		const sealRecord = body.indexOf("const sealRecord = {", seal);
		expect(sealRecord).toBeGreaterThan(seal);
		expect(sealRecord).toBeLessThan(publish);
		const call = body.slice(sealRecord, publish + 700);
		expect(call).toContain("reportJson,");
		expect(call).toContain("reportMarkdown,");
		expect(call).toContain("sealPolicy.key ? { sealKey: sealPolicy.key }");
		expect(call).toContain("resourceIntents: report.resourceIntents");
		const preseal = call.indexOf("validateDurably: () =>");
		const validate = call.indexOf("recorder.preseal(sealRecord)");
		const durable = call.indexOf("sealDurably: () =>");
		const record = call.indexOf("recorder.sealed(sealRecord)");
		expect(preseal).toBeGreaterThan(-1);
		expect(validate).toBeGreaterThan(preseal);
		expect(durable).toBeGreaterThan(-1);
		expect(record).toBeGreaterThan(durable);
		expect(call.slice(0, preseal)).toContain("reportJson,");
	});

	it("wraps the whole run so a throw past the reservation cannot leave a silent RUNNING row", () => {
		const wrapper = RUNNER_SRC.slice(
			RUNNER_SRC.indexOf("export async function runVerification("),
			RUNNER_SRC.indexOf("async function runVerificationRecorded("),
		);
		expect(wrapper).toContain(
			"await runVerificationRecorded(config, recorder)",
		);
		expect(wrapper).toContain("await recorder.failed(err)");
		expect(wrapper).toContain("throw err;");
	});
});
