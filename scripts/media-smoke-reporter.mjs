import { resolve } from "node:path";

// A node:test reporter for scripts/editing-media.sh. It prints one fixture's
// totals from the test runner's own events, so the media runner does not have
// to read a human-readable report whose format may change.
export default async function* fixtureTotals(source) {
	// The runner reports a file that declares no test as one passed test named
	// after the file. It is counted apart, so it cannot stand in for a test.
	let emptyFiles = 0;
	for await (const { type, data } of source) {
		if (
			type === "test:pass" &&
			data.nesting === 0 &&
			data.details?.type === "test" &&
			typeof data.file === "string" &&
			resolve(String(data.name)) === data.file
		)
			emptyFiles += 1;
		if (type === "test:summary" && data.file === undefined)
			yield `media fixture totals: ${JSON.stringify({ ...data.counts, emptyFiles })}\n`;
	}
}
