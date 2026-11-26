import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** A failure whose message was written by a gate for its public log. */
export class GateFailure extends Error {
	constructor(message, { details = [], diagnostics = "" } = {}) {
		super(message);
		this.name = "GateFailure";
		this.details = details;
		this.diagnostics = diagnostics;
	}
}

/**
 * True when `moduleUrl` is the script Node was started with. Node resolves
 * symlinks in that path unless it is told to preserve them, so both forms are
 * accepted: comparing one form only made the other start exit 0 without
 * running. A path that does not exist is simply not this script.
 */
export function isEntryPoint(moduleUrl, path = process.argv[1]) {
	if (!path) return false;
	if (moduleUrl === pathToFileURL(resolve(path)).href) return true;
	try {
		return moduleUrl === pathToFileURL(realpathSync(path)).href;
	} catch {
		return false;
	}
}

/** The error a gate reports for a thrown value: a step can reject with anything. */
export function asFailure(value) {
	return value instanceof Error
		? value
		: new GateFailure("A step failed without an error");
}

/** Records the part of a gate that threw; the first recorded part is kept. */
export function atStep(error, step) {
	if (error instanceof Error && Object.isExtensible(error)) error.step ??= step;
	return error;
}

/**
 * The error to report when a gate's work and its cleanup both failed: the
 * first failure, followed in the report by the cleanup failure.
 */
export function withLaterFailure(first, later) {
	if (!(first instanceof Error) || !Object.isExtensible(first)) return later;
	first.later = later;
	return first;
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
		// A cut can split a secret, so the first line after a cut is never
		// returned, whole or not; a cut tail without a line break is empty.
		text() {
			if (!cut) return text;
			const start = text.indexOf("\n");
			return start < 0 ? "" : text.slice(start + 1);
		},
	};
}

// Characters a log viewer does not show: controls other than tab and line
// feed, soft hyphen, zero-width and direction marks, line and paragraph
// separators, lone surrogates and tag characters.
const INVISIBLE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: removes control characters
	/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\ud800-\udfff\u{e0000}-\u{e007f}]/gu;

/**
 * How many leading characters identify a secret that was cut short. A
 * formatter that shortens a value prints a start of the secret, which an exact
 * match misses. A URL with credentials is known by everything up to the first
 * character of its password, a long token by its first eight characters; a
 * shorter secret is matched whole (0).
 */
function identifyingStart(secret) {
	if (!secret.includes("://")) return secret.length >= 16 ? 8 : 0;
	const user = /^[a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]*:(?=[^\s/?#]+@)/i.exec(
		secret,
	);
	return user ? user[0].length + 1 : 0;
}

/** Replaces a secret, and every start of it that is long enough to identify it. */
function withoutSecret(text, secret) {
	const least = identifyingStart(secret);
	if (!least) return text.replaceAll(secret, "[private]");
	const head = secret.slice(0, least);
	let clean = "";
	let from = 0;
	for (let at = text.indexOf(head); at >= 0; at = text.indexOf(head, from)) {
		let end = at + least;
		while (end - at < secret.length && text[end] === secret[end - at]) end++;
		clean += `${text.slice(from, at)}[private]`;
		from = end;
	}
	return clean + text.slice(from);
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
	const visible = (value) => value.replace(INVISIBLE, "");
	const known = [
		...new Set(
			secrets.filter((secret) => typeof secret === "string").map(visible),
		),
	]
		.filter((secret) => secret !== "")
		.sort((a, b) => b.length - a.length);
	const lines = String(text ?? "")
		// biome-ignore lint/suspicious/noControlCharactersInRegex: removes terminal escapes
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.split(/\r?\n|\r/)
		.map((line) => {
			// Invisible characters go first: removed later, they could have split
			// a secret, or the marker below, until after it was looked for.
			let clean = visible(line);
			for (const secret of known) clean = clean.replaceAll(secret, "[private]");
			// Credentials of any URL, up to the last "@" before its path. The
			// pattern starts at a fixed text, so a long line costs linear time.
			clean = clean.replace(/:\/\/[^\s/?#]*@/g, "://[private]@");
			// Cut-off starts come last: found first, the start of a known URL
			// would take "://" with it, and the rule above would then miss the
			// rest of a password that differs from the known one.
			for (const secret of known) clean = withoutSecret(clean, secret);
			return (
				clean
					// The runner reads this marker anywhere in a line as a command.
					.replaceAll("##[", "## [")
					.trimEnd()
					.slice(0, width)
			);
		})
		.filter((line) => line.trim() !== "");
	return keep === "start" ? lines.slice(0, limit) : lines.slice(-limit);
}

/**
 * What a failed gate prints. Messages, details and child output are shown only
 * when the gate attached them; details and child output are redacted and
 * bounded. Every line starts with text of the gate's own, so child output
 * cannot begin a line and be read by a CI runner as a workflow command.
 */
export function failureLines(error, { secrets = [], nested = false } = {}) {
	const gate = error instanceof GateFailure;
	const authored =
		gate ||
		(error instanceof assert.AssertionError &&
			error.generatedMessage === false);
	const safe = (text, options) => publicLines(text, { secrets, ...options });
	const lines = [];
	if (typeof error?.step === "string")
		for (const line of safe(error.step, { limit: 1, keep: "start" }))
			lines.push(`Step: ${line}`);
	// A foreign message can quote private input; its kind and code cannot.
	const code = [error?.code, error?.cause?.code].find(
		(value) => typeof value === "string" && value !== "",
	);
	const reason = authored
		? error.message
		: `${error?.name ?? "Error"}${code ? ` ${code}` : ""} (message withheld)`;
	// An equality assertion appends the values it compared to its message, so
	// only the first line of an assertion's message is the gate's own.
	for (const line of safe(reason, { limit: gate ? 3 : 1, keep: "start" }))
		lines.push(`Reason: ${line}`);
	const details = [];
	for (const detail of gate && Array.isArray(error.details)
		? error.details
		: [])
		for (const [index, line] of safe(detail, { keep: "start" }).entries())
			details.push(index === 0 ? `  - ${line}` : `    | ${line}`);
	lines.push(...details.slice(0, 160));
	if (details.length > 160)
		lines.push(`  - ${details.length - 160} more lines not shown`);
	const tail = gate ? safe(error.diagnostics) : [];
	if (tail.length) {
		lines.push(`Last ${tail.length} lines of the failed command:`);
		for (const line of tail) lines.push(`  | ${line}`);
	}
	// A cleanup that failed after the work failed is reported after it.
	if (!nested && error?.later !== undefined) {
		lines.push("A later step also failed:");
		lines.push(...failureLines(error.later, { secrets, nested: true }));
	}
	return lines;
}
