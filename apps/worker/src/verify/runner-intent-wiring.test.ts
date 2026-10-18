import { readFile, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { type EncodingPlan, encodingPlanSchema } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { classifySendFailure } from "./resource-intent";
import { liveApiFor, submit, withVerificationLabel } from "./runner";

/**
 * The VOD spend site's half of EV-01.
 *
 * `submit` is driven for real against a fake fetch: every way a paid POST can
 * fail is classified by WHERE it failed relative to the wire, because the old
 * version threw one undifferentiated error and the caller then walked away
 * from a job that was billing. The `runOne` flow around it needs a database, a
 * product and an encoder, so — like run-record-wiring.test.ts — its ORDER is
 * pinned by shape: intent before send, lookup instead of re-send, teardown
 * before seal.
 */

const RUNNER_SRC = await promisify(readFile)(
	new URL("./runner.ts", import.meta.url),
	"utf8",
);

const FIXTURE = JSON.parse(
	readFileSync(
		join(
			import.meta.dirname,
			"../../../../packages/core/src/plan/__fixtures__/fixed-bitrate-hls-on-aws.plan.json",
		),
		"utf8",
	),
) as unknown;

const plan = (): EncodingPlan => encodingPlanSchema.parse(FIXTURE);

const KEY =
	"verify:2026-08-31T00-00-00-000-abc123:fixed-bitrate-hls-on-aws:VOD_JOB";
const SHA = "a".repeat(64);
const DISPATCH = {
	verificationRunId: "00000000-0000-4000-8000-000000000001",
	runGeneration: 0,
	intentId: "00000000-0000-4000-8000-000000000002",
	intentGeneration: 1,
	token: "verify-dispatch:11111111-1111-4111-8111-111111111111",
};
const CONFIG = { baseUrl: "http://product.test", apiToken: "bo_token" };

function body() {
	return {
		name: "n",
		plan: plan(),
		verificationKey: KEY,
		requestSha256: SHA,
		verificationDispatch: DISPATCH,
	};
}

async function withRedirectServer<T>(
	status: 307 | 308,
	run: (
		baseUrl: string,
		counts: { create: number; replay: number },
	) => Promise<T>,
): Promise<T> {
	const counts = { create: 0, replay: 0 };
	const server = createServer((request, response) => {
		if (
			request.method === "POST" &&
			(request.url === "/api/encoding-jobs" ||
				request.url === "/api/live-channels")
		)
			counts.create += 1;
		if (request.method === "POST" && request.url === "/redirected-create") {
			counts.replay += 1;
		}
		response.writeHead(status, { location: "/redirected-create" });
		response.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	try {
		return await run(`http://127.0.0.1:${port}`, counts);
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
}

const responding =
	(status: number, text: string): typeof fetch =>
	async () =>
		new Response(text, { status });

describe("submit — every failure says where it happened relative to the wire", () => {
	it.each([
		307, 308,
	] as const)("an HTTP %s redirect fails AMBIGUOUS after one wire POST and never replays the paid CREATE", async (status) => {
		await withRedirectServer(status, async (baseUrl, counts) => {
			const result = await submit(
				{ baseUrl, apiToken: "bo_token" },
				undefined,
				body(),
			);
			expect(result).toMatchObject({ ok: false, phase: "AMBIGUOUS" });
			expect(counts).toEqual({ create: 1, replay: 0 });
		});
	});

	it("a 201 with an id is ok, and the request carried the key and the SHA", async () => {
		const seen: { url: string; body: unknown }[] = [];
		const fetchImpl: typeof fetch = async (url, init) => {
			seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
			return new Response(JSON.stringify({ id: "job-1" }), { status: 201 });
		};
		const result = await submit(CONFIG, undefined, body(), fetchImpl);
		expect(result).toEqual({ ok: true, jobId: "job-1", replayed: false });
		expect(seen[0]?.url).toBe("http://product.test/api/encoding-jobs");
		expect(seen[0]?.body).toMatchObject({
			verificationKey: KEY,
			requestSha256: SHA,
			verificationDispatch: DISPATCH,
		});
	});

	it("a 200 with replayed:true is ok and says so — the product answered with the job already paid for", async () => {
		const result = await submit(
			CONFIG,
			undefined,
			body(),
			responding(200, JSON.stringify({ id: "job-existing", replayed: true })),
		);
		expect(result).toEqual({ ok: true, jobId: "job-existing", replayed: true });
	});

	it("a refused socket is BEFORE_SEND — nothing can exist", async () => {
		const result = await submit(CONFIG, undefined, body(), async () => {
			throw Object.assign(new TypeError("fetch failed"), {
				cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3100"), {
					code: "ECONNREFUSED",
				}),
			});
		});
		expect(result).toMatchObject({ ok: false, phase: "BEFORE_SEND" });
	});

	it("a codeless throw (socket hang up), a body-read failure, an unparseable body and a body with no id are all AMBIGUOUS", async () => {
		const cases: [string, typeof fetch][] = [
			[
				"socket hang up",
				async () => {
					throw new Error("socket hang up");
				},
			],
			[
				"body read",
				async () =>
					({
						ok: true,
						status: 201,
						text: async () => {
							throw new Error("aborted");
						},
					}) as unknown as Response,
			],
			["unparseable", responding(201, "<html>gateway</html>")],
			["no id", responding(201, JSON.stringify({ name: "n" }))],
		];
		for (const [name, fetchImpl] of cases) {
			const result = await submit(CONFIG, undefined, body(), fetchImpl);
			expect(result, name).toMatchObject({ ok: false, phase: "AMBIGUOUS" });
		}
	});

	it("only a machine-readable product refusal is REFUSED; timeouts and unknown 4xx are AMBIGUOUS", async () => {
		for (const [status, phase] of [
			[400, "AMBIGUOUS"],
			[408, "AMBIGUOUS"],
			[422, "AMBIGUOUS"],
			[425, "AMBIGUOUS"],
			[429, "AMBIGUOUS"],
			[409, "AMBIGUOUS"],
			[500, "AMBIGUOUS"],
			[503, "AMBIGUOUS"],
		] as const) {
			const result = await submit(
				CONFIG,
				undefined,
				body(),
				responding(status, JSON.stringify({ error: "x" })),
			);
			expect(result, String(status)).toMatchObject({
				ok: false,
				phase,
				httpStatus: status,
			});
		}
	});

	it("the server's different-SHA conflict is AMBIGUOUS so the existing paid key enters lookup/cleanup", async () => {
		const result = await submit(
			CONFIG,
			undefined,
			body(),
			responding(
				409,
				JSON.stringify({
					error: "verificationKey was already used for a different request",
					details: {
						code: "VERIFICATION_KEY_SHA_CONFLICT",
						verificationKey: KEY,
					},
				}),
			),
		);
		expect(result).toMatchObject({
			ok: false,
			phase: "AMBIGUOUS",
			httpStatus: 409,
			errorCode: "VERIFICATION_KEY_SHA_CONFLICT",
		});
	});

	it.each([
		"VERIFICATION_DISPATCH_FENCE_REQUIRED",
		"VERIFICATION_DISPATCH_FENCE_REJECTED",
	] as const)("the server's %s refusal is definitive and is never retried", async (code) => {
		const result = await submit(
			CONFIG,
			undefined,
			body(),
			responding(
				409,
				JSON.stringify({
					error: "verification dispatch refused",
					details: { code, verificationKey: KEY },
				}),
			),
		);
		expect(result).toMatchObject({
			ok: false,
			phase: "REFUSED",
			httpStatus: 409,
			errorCode: code,
		});
	});
});

describe("liveApiFor — paid CREATE redirects fail closed at the wire", () => {
	it.each([
		307, 308,
	] as const)("an HTTP %s redirect is AMBIGUOUS after one wire POST and never replays the Live CREATE", async (status) => {
		await withRedirectServer(status, async (baseUrl, counts) => {
			let failure: unknown;
			try {
				await liveApiFor({ baseUrl, apiToken: "bo_token" }, undefined)(
					"/api/live-channels",
					{ method: "POST", body: { plan: {} } },
				);
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(Error);
			expect(classifySendFailure(failure)).toBe("AMBIGUOUS");
			expect(counts).toEqual({ create: 1, replay: 0 });
		});
	});
});

describe("withVerificationLabel — the key rides the plan as a label", () => {
	it("appends the label once, keeps existing labels, and the plan still parses", () => {
		const base = plan();
		const labelled = withVerificationLabel(
			{ ...base, bitmovin: { ...base.bitmovin, labels: ["team:qa"] } },
			KEY,
		);
		expect(labelled.bitmovin.labels).toEqual(["team:qa", `verify-key:${KEY}`]);
		expect(withVerificationLabel(labelled, KEY).bitmovin.labels).toEqual(
			labelled.bitmovin.labels,
		);
		expect(encodingPlanSchema.safeParse(labelled).success).toBe(true);
		// The input is not mutated.
		expect(base.bitmovin.labels).toBeUndefined();
	});
});

describe("the VOD spend site, pinned by shape and order (EV-01)", () => {
	const body = RUNNER_SRC.slice(RUNNER_SRC.indexOf("const runOne = async ("));
	const at = (needle: string, from = 0) => {
		const index = body.indexOf(needle, from);
		expect(index, needle).toBeGreaterThan(-1);
		return index;
	};

	it("commits PREPARED, then SUBMITTED, BEFORE the submit — and a failed write returns before anything is sent", () => {
		const prepare = at("intents.prepare({");
		const submitted = at("await intent.submitted();");
		const send = at("await submit(config, session, {");
		expect(submitted).toBeGreaterThan(prepare);
		expect(send).toBeGreaterThan(submitted);
		// Between the SUBMITTED write and the send there is a catch that returns.
		expect(body.slice(submitted, send)).toContain("nothing was sent");
		expect(body.slice(prepare, submitted)).toContain("nothing was submitted");
		expect(body.slice(submitted, send + 800)).toContain("verificationDispatch");
	});

	it("the submit is sent exactly ONCE per scenario, and an AMBIGUOUS answer is resolved by LOOKUP, never by a second send", () => {
		expect(body.match(/await submit\(config, session, \{/g)?.length).toBe(1);
		const send = at("await submit(config, session, {");
		const ambiguous = at("await intent.ambiguous(sent.error);");
		const lookup = at("await intent.resolve();", ambiguous);
		const proceed = at("const terminal = await awaitTerminal(config, jobId);");
		expect(lookup).toBeGreaterThan(ambiguous);
		expect(lookup).toBeLessThan(proceed);
		expect(body.slice(ambiguous, proceed)).not.toContain("await submit(");
		const fault = at("shouldInjectPostCreateResponseLoss(", send);
		expect(fault).toBeGreaterThan(send);
		expect(fault).toBeLessThan(ambiguous);
		const claimKnownCreated = at("jobId = sent.jobId;", send);
		const captureKnownCreated = at(
			"await intent.recordCreateResponseId(sent.jobId);",
			send,
		);
		const injectedAmbiguous = at("await intent.ambiguous(reason);", fault);
		expect(captureKnownCreated).toBeGreaterThan(claimKnownCreated);
		expect(captureKnownCreated).toBeLessThan(fault);
		expect(captureKnownCreated).toBeLessThan(injectedAmbiguous);
		expect(claimKnownCreated).toBeLessThan(injectedAmbiguous);
		expect(body.slice(fault, proceed)).toContain("noteCanaryAdoption(");
		const mismatch = at("if (found.localId !== sent.jobId)", fault);
		const mismatchEnd = at("jobId = found.localId;", mismatch);
		const mismatchBody = body.slice(mismatch, mismatchEnd);
		expect(mismatchBody).toContain("await ensureTerminal({");
		expect(mismatchBody).toContain("cleanupDeps(found.localId)");
		expect(mismatchBody).toContain("additionalCanaryClosures.push(");
		expect(mismatchBody).toContain(
			"both resources are included in bounded cleanup",
		);
		expect(mismatchBody).not.toContain("await submit(");
		const failureHandler = body.slice(at("} catch (err) {", proceed));
		expect(failureHandler).toContain("if (!jobId)");
		expect(failureHandler).toContain("cleanupDeps(abandoned)");
		expect(failureHandler).toContain("await closeIntent(abandoned, cleanup)");
		// The three refusals of the send are each closed on the intent.
		expect(body.slice(0, proceed)).toContain(
			"await intent.neverSent(sent.error);",
		);
		expect(body.slice(0, proceed)).toContain(
			"await intent.refused(sent.error);",
		);
	});

	it("every ending that read the provider closes the intent, right after it records the cleanup", () => {
		const endings = [
			...body.matchAll(/await recordCleanup\(s\.name, \w+, cleanup\);/g),
		].map((m) => m.index as number);
		expect(endings.length).toBe(2);
		for (const site of endings) {
			expect(body.slice(site, site + 200)).toContain("await closeIntent(");
		}
		// …and the FINISHED ending reads the provider back rather than trusting the row.
		const finished = at(
			"await closeIntent(jobId, await providerReadback(jobId));",
		);
		expect(finished).toBeGreaterThan(at("const verified = await verifyJob({"));
		expect(body.match(/await closeIntent\(/g)?.length).toBe(3);
	});

	it("the ledger is installed right after the reservation and before preflight", () => {
		const whole = RUNNER_SRC.slice(
			RUNNER_SRC.indexOf("async function runVerificationRecorded("),
		);
		const reserve = whole.indexOf("await recorder.reserve({");
		const install = whole.indexOf("intentLedgerFor.set(config, intents);");
		const pre = whole.indexOf("await preflight({");
		expect(reserve).toBeGreaterThan(-1);
		expect(install).toBeGreaterThan(reserve);
		expect(pre).toBeGreaterThan(install);
	});

	it("the run tears down every intent BEFORE it seals, and an unresolved intent throws without writing report.seal", () => {
		const whole = RUNNER_SRC.slice(
			RUNNER_SRC.indexOf("async function runVerificationRecorded("),
		);
		const teardown = whole.indexOf("const teardown = await intents.teardown({");
		const canaryExactCandidates = whole.indexOf(
			"const canaryExactCandidates = canaryIntent",
		);
		const refusal = whole.indexOf("if (!teardown.sealable || canaryError) {");
		const seal = whole.indexOf("const seal = sealReport(reportJson,");
		const publish = whole.indexOf("await publishSealedRunReport({");
		const record = whole.indexOf("recorder.sealed(sealRecord)", publish);
		expect(teardown).toBeGreaterThan(-1);
		expect(canaryExactCandidates).toBeGreaterThan(teardown);
		const exactCandidateFilter = whole.slice(
			canaryExactCandidates,
			whole.indexOf("const canaryError", canaryExactCandidates),
		);
		expect(exactCandidateFilter).toContain('matchedBy.includes("key")');
		expect(exactCandidateFilter).toContain(
			"candidate.requestSha256 === canaryIntent.requestSha256",
		);
		expect(refusal).toBeGreaterThan(teardown);
		expect(seal).toBeGreaterThan(refusal);
		expect(publish).toBeGreaterThan(seal);
		expect(record).toBeGreaterThan(publish);
		const refusalBlock = whole.slice(refusal, seal);
		expect(refusalBlock).toContain("throw new Error(");
		expect(refusalBlock).not.toContain("report.seal");
		expect(refusalBlock).toContain("NOT SEALED");
	});

	it("a live dry run prepares the rewritten plan before returning a non-green verdict", () => {
		const live = RUNNER_SRC.slice(
			RUNNER_SRC.indexOf('if (s.kind === "LIVE")'),
			RUNNER_SRC.indexOf("if (!s.plan)"),
		);
		const dry = live.indexOf("if (config.dryRun)");
		expect(dry).toBeGreaterThan(-1);
		const block = live.slice(dry, live.indexOf("const liveSpend"));
		expect(block).toContain("prepareLiveScenarioForRun({");
		expect(block).toContain('verdict: "SKIP" as const');
		expect(block).not.toContain('verdict: "PASS" as const');
	});

	it("the live spend site hands the runner intent hooks keyed by (run, scenario, LIVE_CHANNEL)", () => {
		const live = RUNNER_SRC.slice(
			RUNNER_SRC.indexOf("async function runLive("),
			RUNNER_SRC.indexOf("export function vodVerdictForCounts("),
		);
		expect(live).toContain('"LIVE_CHANNEL",');
		expect(live).toContain("intent: {");
		expect(live).toContain("intents.prepare({");
		expect(live).toContain("const intents = intentLedgerFor.get(config);");
	});

	it("the public MSL edge reader never auto-follows redirects", () => {
		const live = RUNNER_SRC.slice(
			RUNNER_SRC.indexOf("async function runLive("),
			RUNNER_SRC.indexOf("export function vodVerdictForCounts("),
		);
		// The reader is the pure factory in edge-reader.ts (rev411 M-A), whose
		// behaviour edge-reader.test.ts exercises; this arm keeps the wiring and
		// the redirect policy readable from the source.
		expect(live).toContain("readEdge: edgeReaderFor(),");
		const reader = readFileSync(
			new URL("./edge-reader.ts", import.meta.url),
			"utf8",
		);
		expect(reader).toContain('fetchImpl(url, { redirect: "manual" })');
		expect(reader).toContain("redirected: res.redirected");
		expect(reader).toContain("finalUrl: res.url");
	});
});
