import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	liveMslEdgeAllowedHosts,
	liveMslEdgeBaseUrlForRun,
	resolveLiveEvidenceImage,
	resolveLiveMslEdgeAllowedRoots,
	resolveLiveMslEdgeBaseUrl,
} from "./runner";

/**
 * The CLI edge base and the
 * runner's evidence wiring, pinned by shape the way run-record-wiring.test.ts
 * pins the recorder's call sites: `runVerification` needs a database, a
 * product and an encoder, so what a test can reach is the rule (the flag /
 * env resolver) and the fact that the runner CALLS it and the recorder.
 */

describe("resolveLiveMslEdgeBaseUrl — --live-msl-edge-base-url, else VERIFY_LIVE_MSL_EDGE_BASE_URL", () => {
	it("is undefined when neither the flag nor the env is set — every MSL leg stays UNOBSERVED", () => {
		expect(resolveLiveMslEdgeBaseUrl(undefined, {})).toBeUndefined();
		expect(
			resolveLiveMslEdgeBaseUrl(undefined, {
				VERIFY_LIVE_MSL_EDGE_BASE_URL: "  ",
			}),
		).toBeUndefined();
	});

	it("takes the flag over the env, and normalises the base to a directory", () => {
		expect(
			resolveLiveMslEdgeBaseUrl(
				"https://bitmovinmsl4hlsjp.akamaized.net/hls/live/2126636/ev",
				{ VERIFY_LIVE_MSL_EDGE_BASE_URL: "https://other.akamaized.net/x/" },
			),
		).toBe("https://bitmovinmsl4hlsjp.akamaized.net/hls/live/2126636/ev/");
		expect(
			resolveLiveMslEdgeBaseUrl(undefined, {
				VERIFY_LIVE_MSL_EDGE_BASE_URL: "https://other.akamaized.net/x/",
			}),
		).toBe("https://other.akamaized.net/x/");
	});

	it.each([
		["plain http", "http://x.akamaized.net/ev/", /not https/],
		["userinfo", "https://u:p@x.akamaized.net/ev/", /userinfo/],
		[
			"a signed query",
			"https://x.akamaized.net/ev/?hdnts=abc",
			/query or fragment/,
		],
		[
			"a host off the allowlist",
			"https://edge.example/ev/",
			/not an allowed delivery host/,
		],
	])("REFUSES %s before anything is spent", (_name, raw, reason) => {
		expect(() => resolveLiveMslEdgeBaseUrl(raw, {})).toThrow(reason);
		expect(() =>
			resolveLiveMslEdgeBaseUrl(undefined, {
				VERIFY_LIVE_MSL_EDGE_BASE_URL: raw,
			}),
		).toThrow(reason);
	});

	it("admits a non-Akamai host only when VERIFY_LIVE_MSL_EDGE_ALLOWED_HOSTS names it", () => {
		expect(
			resolveLiveMslEdgeBaseUrl("https://edge.lab.example/ev/", {
				VERIFY_LIVE_MSL_EDGE_ALLOWED_HOSTS: "edge.lab.example, .other.example",
			}),
		).toBe("https://edge.lab.example/ev/");
		expect(
			resolveLiveMslEdgeBaseUrl("https://a.other.example/ev/", {
				VERIFY_LIVE_MSL_EDGE_ALLOWED_HOSTS: "edge.lab.example, .other.example",
			}),
		).toBe("https://a.other.example/ev/");
	});
});

describe("liveMslEdgeBaseUrlForRun — the flag, else the credential's edgeBaseUrl (2026-09-02)", () => {
	const CREDENTIAL_ROOT =
		"https://bitmovinmsl4hlsjp.akamaized.net/hls/live/2126636/bitmovinhlsjp20260821";

	it("defaults from the credential when no flag was given — validated and normalised to a directory", () => {
		expect(
			liveMslEdgeBaseUrlForRun({
				override: undefined,
				credentialEdgeBaseUrl: CREDENTIAL_ROOT,
				allowedHosts: undefined,
			}),
		).toEqual({ ok: true, url: `${CREDENTIAL_ROOT}/`, source: "credential" });
	});

	it("keeps the flag as the override, untouched, even when the credential declares a root", () => {
		expect(
			liveMslEdgeBaseUrlForRun({
				override: "https://other.akamaized.net/hls/live/1/ev/",
				credentialEdgeBaseUrl: CREDENTIAL_ROOT,
				allowedHosts: undefined,
			}),
		).toEqual({
			ok: true,
			url: "https://other.akamaized.net/hls/live/1/ev/",
			source: "flag",
		});
	});

	it("is none — the leg stays UNOBSERVED — when neither exists", () => {
		for (const declared of [undefined, "", "   ", 42, null]) {
			expect(
				liveMslEdgeBaseUrlForRun({
					override: undefined,
					credentialEdgeBaseUrl: declared,
					allowedHosts: undefined,
				}),
			).toEqual({ ok: true, url: undefined, source: "none" });
		}
	});

	it("refuses a credential root off the delivery allowlist — a customer CNAME is a fine link and not a harness egress", () => {
		const out = liveMslEdgeBaseUrlForRun({
			override: undefined,
			credentialEdgeBaseUrl: "https://live.example.com/hls/live/1/ev",
			allowedHosts: undefined,
		});
		expect(out.ok).toBe(false);
		expect(out.ok ? "" : out.reason).toMatch(/not an allowed delivery host/);
		// …and names the override the operator can reach for.
		expect(out.ok ? "" : out.reason).toMatch(/--live-msl-edge-base-url/);
		// The same CNAME reads once VERIFY_LIVE_MSL_EDGE_ALLOWED_HOSTS names it.
		expect(
			liveMslEdgeBaseUrlForRun({
				override: undefined,
				credentialEdgeBaseUrl: "https://live.example.com/hls/live/1/ev",
				allowedHosts: ["live.example.com"],
			}),
		).toEqual({
			ok: true,
			url: "https://live.example.com/hls/live/1/ev/",
			source: "credential",
		});
	});

	it.each([
		["plain http", "http://x.akamaized.net/hls/live/1/ev", /not https/],
		["userinfo", "https://u:p@x.akamaized.net/hls/live/1/ev", /userinfo/],
		[
			"a signed query",
			"https://x.akamaized.net/ev?hdnts=abc",
			/query or fragment/,
		],
	])("refuses a hand-edited credential root with %s before the channel is created", (_name, declared, reason) => {
		const out = liveMslEdgeBaseUrlForRun({
			override: undefined,
			credentialEdgeBaseUrl: declared,
			allowedHosts: undefined,
		});
		expect(out.ok).toBe(false);
		expect(out.ok ? "" : out.reason).toMatch(reason);
	});
});

describe("liveMslEdgeAllowedHosts — VERIFY_LIVE_MSL_EDGE_ALLOWED_HOSTS, one parser for every reader", () => {
	it("splits, trims and drops empties", () => {
		expect(liveMslEdgeAllowedHosts({})).toEqual([]);
		expect(
			liveMslEdgeAllowedHosts({
				VERIFY_LIVE_MSL_EDGE_ALLOWED_HOSTS:
					" edge.lab.example, .other.example,, ",
			}),
		).toEqual(["edge.lab.example", ".other.example"]);
	});
});

describe("resolveLiveMslEdgeAllowedRoots — explicit cross-origin roots only", () => {
	it("normalizes flag roots and takes the flag over env", () => {
		expect(
			resolveLiveMslEdgeAllowedRoots(
				"https://a.akamaized.net/event-a, https://b.akamaihd.net/event-b/",
				{
					VERIFY_LIVE_MSL_EDGE_ALLOWED_ROOTS: "https://ignored.akamaized.net/x",
				},
			),
		).toEqual([
			"https://a.akamaized.net/event-a/",
			"https://b.akamaihd.net/event-b/",
		]);
	});

	it.each([
		["plain HTTP", "http://a.akamaized.net/event/", /not https/],
		["userinfo", "https://u:p@a.akamaized.net/event/", /userinfo/],
		["query", "https://a.akamaized.net/event/?token=x", /query or fragment/],
		["unallowed host", "https://evil.example/event/", /not an allowed/],
	])("refuses %s before spend", (_name, raw, reason) => {
		expect(() => resolveLiveMslEdgeAllowedRoots(raw, {})).toThrow(reason);
	});
});

describe("resolveLiveEvidenceImage — immutable image identity before spend", () => {
	const digest = "a".repeat(64);

	it("takes the flag over env and accepts an OCI reference or local image id", () => {
		expect(
			resolveLiveEvidenceImage(`registry.example/worker@sha256:${digest}`, {
				VERIFY_LIVE_EVIDENCE_IMAGE: `sha256:${"b".repeat(64)}`,
			}),
		).toBe(`registry.example/worker@sha256:${digest}`);
		expect(
			resolveLiveEvidenceImage(undefined, {
				VERIFY_LIVE_EVIDENCE_IMAGE: `sha256:${digest}`,
			}),
		).toBe(`sha256:${digest}`);
	});

	it.each([
		"worker:latest",
		"worker@sha256:abc",
		"unknown",
	])("refuses mutable or non-exact image identity %s", (raw) => {
		expect(() => resolveLiveEvidenceImage(raw, {})).toThrow(
			/immutable sha256 digest/,
		);
	});
});

describe("the evidence wiring, pinned by shape", () => {
	const runner = readFileSync(new URL("./runner.ts", import.meta.url), "utf8");
	const live = readFileSync(
		new URL("./runner-live.ts", import.meta.url),
		"utf8",
	);

	it("main() validates the edge base through the resolver and hands it to runVerification", () => {
		const main = runner.slice(runner.indexOf("export async function main("));
		expect(main).toMatch(
			/resolveLiveMslEdgeBaseUrl\(\s*flag\("live-msl-edge-base-url"\)/,
		);
		expect(main).toContain("resolveLiveMslEdgeAllowedRoots(");
		expect(main).toContain("resolveLiveEvidenceImage(");
		// Inside the argument try — a bad value is a refusal (exit 2), not a crash.
		expect(main.indexOf("resolveLiveMslEdgeBaseUrl(")).toBeLessThan(
			main.indexOf("} catch (err) {"),
		);
	});

	it("the scenario loop takes the MSL edge base through liveMslEdgeBaseUrlForRun, refuses INVALID pre-spend, and main() hands it the allowlist", () => {
		const body = runner.slice(runner.indexOf("const runOne = async ("));
		const dispatch = body.slice(0, body.indexOf("return await runLive("));
		// The rewrite's edge base comes from the resolver's answer, not from the
		// config flag alone — that is what makes the credential the default.
		expect(dispatch).toContain("liveMslEdgeBaseUrlForRun({");
		expect(dispatch).toContain("override: config.liveMslEdgeBaseUrl,");
		expect(dispatch).toContain(
			"credentialEdgeBaseUrl: mslConfig.data.edgeBaseUrl,",
		);
		expect(dispatch).toContain("allowedHosts: config.liveMslEdgeAllowedHosts,");
		expect(dispatch).toContain("? { edgeBaseUrl: mslEdge.url }");
		expect(dispatch).not.toContain(
			"{ edgeBaseUrl: config.liveMslEdgeBaseUrl }",
		);
		// A refused credential root is an INVALID verdict BEFORE the spend site.
		// The slice is the refusal block ALONE — up to the rewrite that follows
		// it, not up to the spend site: that wider slice also held the dry-run
		// catch's `verdict: "INVALID"`, so an INVALID→SKIP mutation of the
		// refusal survived the whole worker suite (review rev401 R1). One
		// verdict in the block, and it is INVALID.
		const refusal = dispatch.indexOf("if (mslEdge && !mslEdge.ok) {");
		const rewrite = dispatch.indexOf("const liveRewrite = {", refusal);
		const spend = dispatch.indexOf("const liveSpend = budget.spend();");
		expect(refusal).toBeGreaterThan(-1);
		expect(rewrite).toBeGreaterThan(refusal);
		expect(spend).toBeGreaterThan(rewrite);
		const block = dispatch.slice(refusal, rewrite);
		expect(block.match(/verdict: "[A-Z]+" as const/g)).toEqual([
			'verdict: "INVALID" as const',
		]);
		// The refusal names the credential AND the resolver's reason — matched on
		// the SOURCE text, not a template (hence the split).
		expect(block).toContain("reason: `verify AKAMAI_MSL credential ${");
		expect(block).toContain("mslEdge.reason}`");
		const main = runner.slice(runner.indexOf("export async function main("));
		expect(main).toContain(
			"liveMslEdgeAllowedHosts: liveMslEdgeAllowedHosts(process.env),",
		);
	});

	it("the live dispatch binds the tuple to the fingerprinted commit/image and records the legs; source bytes come from the feeder seal", () => {
		const body = runner.slice(runner.indexOf("const runOne = async ("));
		const dispatch = body.slice(body.indexOf("return await runLive("));
		const call = dispatch.slice(0, dispatch.indexOf("if (!s.plan) {"));
		expect(call).toContain("commit: fingerprint.commit");
		expect(call).toContain("config.liveEvidenceImage");
		expect(call).not.toContain("sourceIdentityFor(");
		expect(call).toContain("recorder.liveEvidence({ scenario: s.name, legs })");
	});

	it("runLive hands the credential-bound MSL target to the live loop and records evidence before the verdict", () => {
		const fn = runner.slice(runner.indexOf("async function runLive("));
		const scope = fn.slice(
			0,
			fn.indexOf("export function vodVerdictForCounts("),
		);
		expect(scope).toContain(
			"rewrite: paidLiveRewrite(config, scenario.name, rewrite)",
		);
		const helperStart = runner.indexOf("export function paidLiveRewrite(");
		const helperEnd = runner.indexOf("async function runLive(", helperStart);
		expect(helperStart).toBeGreaterThan(-1);
		expect(helperEnd).toBeGreaterThan(helperStart);
		const helper = runner.slice(helperStart, helperEnd);
		expect(helper).toContain(
			"...(rewrite.akamaiMsl ? { akamaiMsl: rewrite.akamaiMsl } : {})",
		);
		expect(helper).not.toContain(
			"{ edgeBaseUrl: rewrite.akamaiMsl.edgeBaseUrl }",
		);
		expect(scope).not.toContain(
			"{ edgeBaseUrl: rewrite.akamaiMsl.edgeBaseUrl }",
		);
		// The edge reader is the pure factory (raw bytes + Last-Modified are
		// pinned by behaviour in edge-reader.test.ts, rev411 M-A), not an
		// inline closure that no test could exercise.
		expect(scope).toContain("readEdge: edgeReaderFor(),");
		expect(scope).not.toContain('res.headers.get("last-modified")');
		const record = scope.indexOf("await recordLiveEvidence(result.evidence)");
		const verdict = scope.indexOf(
			"return outcomeFromLiveResult(result, base, scenario.name)",
		);
		expect(record).toBeGreaterThan(-1);
		expect(verdict).toBeGreaterThan(record);
	});

	it("the live loop binds in-run edge probes to exact MSL outputs and current provider output ids, assembles after cleanup, and returns the tuple on BOTH endings", () => {
		const sample = live.slice(live.indexOf("async function sample("));
		const sampleScope = sample.slice(
			0,
			sample.indexOf("async function awaitRunning("),
		);
		expect(sampleScope).toContain("providerResourcesFromStepLog(");
		expect(sampleScope).toContain("await collectEdgeClosures(");
		expect(sampleScope).toContain("mslOutputs,");
		expect(sampleScope).toContain("providerOutputIds,");
		const loop = live.slice(
			live.indexOf("export async function runLiveScenario("),
		);
		const seal = loop.indexOf("const localCleanup = await sealCleanup(");
		const dossier = loop.indexOf("await closeIntent(localCleanup)");
		const finalize = loop.indexOf(
			"const cleanup = finalizeLiveCleanupSeal(localCleanup",
		);
		const assemble = loop.indexOf("const evidence = assembleLiveEvidence({");
		expect(seal).toBeGreaterThan(-1);
		expect(dossier).toBeGreaterThan(seal);
		expect(finalize).toBeGreaterThan(dossier);
		expect(assemble).toBeGreaterThan(finalize);
		// Both returns after the seal carry `evidence` — the teardown-failure
		// INVALID as much as the normal ending.
		const tail = loop.slice(
			assemble,
			loop.indexOf("} catch (err) {", assemble),
		);
		expect((tail.match(/\n\t+evidence,\n/g) ?? []).length).toBe(2);
	});
});
