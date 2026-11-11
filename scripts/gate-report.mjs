import assert from "node:assert/strict";

/** A failure whose message was written by a gate for its public log. */
export class GateFailure extends Error {
	constructor(message, { details = [], diagnostics = "" } = {}) {
		super(message);
		this.name = "GateFailure";
		this.details = details;
		this.diagnostics = diagnostics;
	}
}

/** Runs one part of a gate; a failure report names the part that threw. */
export async function inStep(step, action) {
	try {
		return await action();
	} catch (error) {
		if (error instanceof Error) error.step ??= step;
		throw error;
	}
}

/** Keeps the end of a child's output for a later failure report. */
export function outputTail(limit = 64 * 1024) {
	let text = "";
	let cut = false;
	return {
		add(chunk) {
			text += chunk;
			if (text.length > limit) {
				text = text.slice(-limit);
				cut = true;
			}
		},
		// A cut can split a secret, so the partial first line is never returned.
		text() {
			if (!cut) return text;
			const start = text.indexOf("\n");
			return start < 0 ? "" : text.slice(start + 1);
		},
	};
}

/**
 * Lines that may appear in a public CI log: known secrets and URL credentials
 * are removed, terminal control is stripped, and count and width are bounded.
 * `keep` selects which end survives the bound.
 */
export function publicLines(
	text,
	{ secrets = [], limit = 80, width = 300, keep = "end" } = {},
) {
	let clean = String(text ?? "");
	const known = [...new Set(secrets)]
		.filter((secret) => typeof secret === "string" && secret !== "")
		.sort((a, b) => b.length - a.length);
	for (const secret of known) clean = clean.replaceAll(secret, "[private]");
	const lines = clean
		// biome-ignore lint/suspicious/noControlCharactersInRegex: removes terminal escapes
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*@/gi, "$1[private]@")
		.split(/\r?\n|\r/)
		.map((line) =>
			line
				.replace(
					// biome-ignore lint/suspicious/noControlCharactersInRegex: removes control characters
					/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g,
					"",
				)
				// The runner reads this marker anywhere in a line as a command.
				.replaceAll("##[", "## [")
				.trimEnd()
				.slice(0, width),
		)
		.filter((line) => line.trim() !== "");
	return keep === "start" ? lines.slice(0, limit) : lines.slice(-limit);
}

/**
 * What a failed gate prints. Messages are shown only when the gate wrote them;
 * details and child output are redacted and bounded. Every line starts with
 * text of the gate's own, so child output cannot begin a line and be read by a
 * CI runner as a workflow command.
 */
export function failureLines(error, { secrets = [] } = {}) {
	const authored =
		error instanceof GateFailure ||
		(error instanceof assert.AssertionError &&
			error.generatedMessage === false);
	const safe = (text, options) => publicLines(text, { secrets, ...options });
	const lines = [];
	if (typeof error?.step === "string")
		for (const line of safe(error.step, { limit: 1 }))
			lines.push(`Step: ${line}`);
	// A foreign message can quote private input; its kind and code cannot.
	const code = [error?.code, error?.cause?.code].find(
		(value) => typeof value === "string" && value !== "",
	);
	const reason = authored
		? error.message
		: `${error?.name ?? "Error"}${code ? ` ${code}` : ""} (message withheld)`;
	for (const line of safe(reason, { limit: 3, keep: "start" }))
		lines.push(`Reason: ${line}`);
	const details = [];
	for (const detail of Array.isArray(error?.details) ? error.details : [])
		for (const [index, line] of safe(detail, { keep: "start" }).entries())
			details.push(index === 0 ? `  - ${line}` : `    | ${line}`);
	lines.push(...details.slice(0, 160));
	if (details.length > 160)
		lines.push(`  - ${details.length - 160} more lines not shown`);
	const tail = safe(error?.diagnostics);
	if (tail.length) {
		lines.push(`Last ${tail.length} lines of the failed command:`);
		for (const line of tail) lines.push(`  | ${line}`);
	}
	return lines;
}
