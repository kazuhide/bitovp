/** Operator-facing conclusion from read-only provider observations. */
export function encodingProbeSummary(tally: ReadonlyMap<string, number>) {
	const terminal = new Set(["FINISHED", "ERROR", "CANCELED", "STOPPED"]);
	const nonTerminal = new Set([
		"CREATED",
		"QUEUED",
		"RUNNING",
		"STARTING",
		"STOPPING",
		"CANCELLING",
		"CANCELING",
	]);
	const live = [...tally].filter(([state]) => nonTerminal.has(state));
	if (
		tally.size === 0 ||
		[...tally.keys()].some(
			(state) => !terminal.has(state) && !nonTerminal.has(state),
		)
	)
		return "HOLD: some encoding states are unverified. Keep the rows and resolve failed or missing observations first.";
	return live.length > 0
		? `DO NOT DELETE: ${live.map(([state, n]) => `${n} ${state}`).join(", ")}`
		: "All queried encodings reported terminal states. Check local references before deleting rows.";
}
