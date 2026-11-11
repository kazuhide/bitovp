// A node:test reporter for scripts/editing-media.sh. It prints one fixture's
// totals from the test runner's own events, so the media runner does not have
// to read a human-readable report whose format may change.
export default async function* fixtureTotals(source) {
	for await (const event of source)
		if (event.type === "test:summary" && event.data.file === undefined)
			yield `media fixture totals: ${JSON.stringify(event.data.counts)}\n`;
}
