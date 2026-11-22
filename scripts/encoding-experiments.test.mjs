import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runExperiments } from "./encoding-experiments.mjs";

const token = `boe_${"A".repeat(43)}`;
const id = "11111111-1111-4111-8111-111111111111";
const v1Profile = "bitovp-vmaf-cuda-1.0.16-3d0h";

function fixture(handler) {
	const calls = [];
	const items = [];
	return {
		calls,
		items,
		api: {
			env: {
				BITOVP_EXPERIMENTS_URL: "http://127.0.0.1:3100",
				BITOVP_API_TOKEN: token,
			},
			fetch: async (url, init) => {
				calls.push({ url: new URL(url), init });
				return handler(calls.length);
			},
			write: (item) => items.push(JSON.parse(item)),
		},
	};
}

test("sends the experiment-only credential to the authorized endpoint", async () => {
	const io = fixture(() => Response.json({ schemaVersion: 1, available: false }));
	await runExperiments(["capabilities", "--json"], io.api);
	assert.equal(io.calls.length, 1);
	assert.equal(io.calls[0].url.pathname, "/api/encoding-experiments/v1/capabilities");
	assert.equal(new Headers(io.calls[0].init.headers).get("authorization"), `Bearer ${token}`);
	assert.equal(io.calls[0].init.redirect, "error");
	assert.deepEqual(io.items, [{ schemaVersion: 1, available: false }]);
});

test("disallows credentials over non-loopback HTTP and credential-bearing URLs", async () => {
	for (const url of ["http://example.test", "https://name:pw@example.test", "https://example.test/redirect?destination=example.test"]) {
		const io = fixture(() => Response.json({}));
		await assert.rejects(runExperiments(["capabilities", "--url", url], io.api), /HTTPS origin/);
		assert.equal(io.calls.length, 0);
	}
});

test("forwards JSON files and a stable idempotency key for enqueue", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bitovp-experiments-cli-"));
	try {
		const path = join(dir, "batch.json");
		const batch = {
			schemaVersion: 1,
			trials: [{ sourceId: "src_1", additionalScoringProfiles: [v1Profile] }],
		};
		await writeFile(path, JSON.stringify(batch));
		const io = fixture(() => Response.json({ items: [], nextCursor: null }, { status: 202 }));
		await runExperiments(["enqueue", id, "--file", path, "--idempotency-key", "trial-set-a"], io.api);
		const [{ url, init }] = io.calls;
		assert.equal(url.pathname, `/api/encoding-experiments/v1/campaigns/${id}/trials`);
		assert.equal(init.method, "POST");
		assert.equal(new Headers(init.headers).get("idempotency-key"), "trial-set-a");
		assert.deepEqual(JSON.parse(init.body), batch);
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});

test("validates a direct NVENC trial with a 1080p QP map larger than 8 KiB", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bitovp-experiments-cli-"));
	try {
		const path = join(dir, "trial.json");
		const trial = {
			sourceId: "src_1",
			codec: "H264",
			sdk: {
				version: "13.0",
				session: { "NV_ENC_RC_PARAMS.qpMapMode": 2 },
				pictures: [{ frameIndex: 0, qpMap: "ff".repeat(8160) }],
			},
		};
		await writeFile(path, JSON.stringify(trial));
		const io = fixture(() => Response.json({ valid: true, trial }));
		await runExperiments(["validate", "--file", path], io.api);
		assert.equal(io.calls[0].url.pathname, "/api/encoding-experiments/v1/validate");
		assert.deepEqual(JSON.parse(io.calls[0].init.body), trial);
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});

test("forwards the scoring profile and constraints to the campaign selector", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bitovp-experiments-cli-"));
	try {
		const file = join(dir, "select.json");
		const body = {
			schemaVersion: 1,
			sourceId: "src_1",
			scoringProfileId: v1Profile,
			constraints: { bitrateLimitBps: 2_000_000 },
		};
		await writeFile(file, JSON.stringify(body));
		const io = fixture(() => Response.json({ status: "selected", trialId: "best" }));
		await runExperiments(["select", id, "--file", file], io.api);
		assert.equal(io.calls[0].url.pathname, "/api/encoding-experiments/v1/campaigns/" + id + "/select");
		assert.equal(io.calls[0].init.method, "POST");
		assert.deepEqual(JSON.parse(io.calls[0].init.body), body);
		assert.deepEqual(io.items, [{ status: "selected", trialId: "best" }]);
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});

test("streams each NDJSON page under the returned snapshot cursor", async () => {
	const scored = {
		id: "one",
		result: {
			scoringProfileId: "official-vmaf-cuda-0.6.1",
			scoreMilli: 90000,
			nvencSdkApplied: { fieldCount: 4, manifestSha256: "b".repeat(64) },
			additionalScores: [{
				scoringProfileId: v1Profile,
				status: "failed",
				failureCode: "VMAF_V1_SCORE_FAILED",
			}],
		},
	};
	const io = fixture((n) => Response.json(n === 1
		? { items: [scored], nextCursor: "snapshot:1:1" }
		: { items: [{ id: "two" }], nextCursor: null }));
	await runExperiments(["export", id, "--format", "ndjson"], io.api);
	assert.deepEqual(io.calls.map(({ url }) => url.searchParams.get("cursor")), [null, "snapshot:1:1"]);
	assert.deepEqual(io.items, [scored, { id: "two" }]);
});

test("fails a remote response with a public code and avoids reflecting its message", async () => {
	const io = fixture(() => Response.json(
		{ error: token, details: { code: "TOKEN_SCOPE_DENIED" } },
		{ status: 403 },
	));
	await assert.rejects(runExperiments(["sources"], io.api), (error) => {
		assert.equal(error.code, "TOKEN_SCOPE_DENIED");
		assert.equal(error.status, 403);
		assert.ok(!error.message.includes(token));
		return true;
	});
	assert.deepEqual(io.items, []);
});
