import assert from "node:assert/strict";
import test from "node:test";
import {
	assertPendingSubmissions,
	assertSubmissionIsolation,
	restoreFailureSummary,
} from "./nonpaid-submit-proof.mjs";

test("restore diagnostics expose only fixed stages without raw error details", () => {
	for (const stage of [
		"fixture verification",
		"backup",
		"isolated restore",
		"restored data and schema comparison",
		"cleanup",
	])
		assert.equal(
			restoreFailureSummary(
				new Error(
					`Database restore proof failed at ${stage}; fixture diagnostics are private`,
				),
			),
			`Database restore diagnostic: ${stage}`,
		);
	for (const value of [
		null,
		{ message: "private" },
		new Error("private URL or secret"),
		new Error(
			"Database restore proof failed at private-secret; fixture diagnostics are private",
		),
	])
		assert.equal(restoreFailureSummary(value), null);
});

const isolation = () => ({
	internal: true,
	networks: ["owned_default"],
	network: "owned_default",
	worker: { running: false, status: "exited", restart: "no" },
});
test("real submissions require a stopped worker and a single internal network", () => {
	assertSubmissionIsolation(isolation());
	for (const change of [
		(value) => {
			value.internal = false;
		},
		(value) => {
			value.networks.push("external");
		},
		(value) => {
			value.worker.running = true;
		},
		(value) => {
			value.worker.status = "restarting";
		},
		(value) => {
			value.worker.restart = "always";
		},
	]) {
		const value = isolation();
		change(value);
		assert.throws(() => assertSubmissionIsolation(value));
	}
});

const proof = () => ({
	counts: { accounts: 1, credentials: 1, vod: 1, live: 1 },
	vod: [
		{
			id: "vod",
			status: "QUEUED",
			bitmovinEncodingId: null,
			stepLog: [{ status: "PENDING" }],
		},
	],
	live: [
		{
			id: "live",
			status: "CREATED",
			bitmovinEncodingId: null,
			stepLog: [{ status: "PENDING" }],
		},
	],
});
test("database proof rejects extra jobs, provider resources and any executed step", () => {
	assertPendingSubmissions(proof(), {
		vod: { id: "vod" },
		live: { id: "live" },
	});
	for (const change of [
		(value) => {
			value.counts.accounts++;
		},
		(value) => {
			value.counts.vod++;
		},
		(value) => {
			value.live.push(value.live[0]);
		},
		(value) => {
			value.vod[0].id = "unobserved";
		},
		(value) => {
			value.live[0].bitmovinEncodingId = "unexpected-provider-id";
		},
		(value) => {
			value.live[0].status = "PROVISIONING";
		},
		(value) => {
			value.vod[0].stepLog[0].status = "DONE";
		},
		(value) => {
			value.vod[0].stepLog = [];
		},
	]) {
		const value = proof();
		change(value);
		assert.throws(() =>
			assertPendingSubmissions(value, {
				vod: { id: "vod" },
				live: { id: "live" },
			}),
		);
	}
});
