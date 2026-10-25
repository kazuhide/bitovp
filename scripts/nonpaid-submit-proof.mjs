import assert from "node:assert/strict";

export function restoreFailureSummary(error) {
	if (!(error instanceof Error)) return null;
	const stage =
		/^Database restore proof failed at (fixture verification|backup|isolated restore|restored data and schema comparison|cleanup); fixture diagnostics are private$/.exec(
			error.message,
		)?.[1];
	return stage ? `Database restore diagnostic: ${stage}` : null;
}

export function assertSubmissionIsolation(proof) {
	assert.equal(proof.internal, true, "Submission network must be internal");
	assert.deepEqual(
		proof.networks,
		[proof.network],
		"Unexpected network attachment",
	);
	assert.deepEqual(
		proof.worker,
		{
			running: false,
			status: "exited",
			restart: "no",
		},
		"The job consumer must remain stopped",
	);
}

export function assertPendingSubmissions(database, submissions) {
	assert.deepEqual(
		database.counts,
		{
			accounts: 1,
			credentials: 1,
			vod: 1,
			live: 1,
		},
		"Only the synthetic submission fixtures may exist",
	);
	for (const [kind, status] of [
		["vod", "QUEUED"],
		["live", "CREATED"],
	]) {
		assert.equal(database[kind]?.length, 1, "Unexpected saved job count");
		const row = database[kind][0];
		assert.equal(
			row.id,
			submissions[kind]?.id,
			"Saved job was not observed by the browser",
		);
		assert.equal(row.status, status, "A job left its unprocessed state");
		assert.equal(
			row.bitmovinEncodingId,
			null,
			"A provider resource was created",
		);
		assert(
			Array.isArray(row.stepLog) && row.stepLog.length > 0,
			"No compiled steps were saved",
		);
		assert(
			row.stepLog.every((step) => step.status === "PENDING"),
			"A compiled step was executed",
		);
	}
}
