type FilenameState = {
	transitions: { to: number; characters: string | null }[];
};
export type FilenameLanguage = { states: FilenameState[]; end: number };
const DIGITS = "0123456789";
const ALPHANUMERIC = `${DIGITS}ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz`;

export type FilenameTokens = { policyTokens: boolean; randomTokens: boolean };

/** A bounded automaton with explicit token provenance for every path component. */
function filenameLanguage(
	parts: readonly ({ value: string } & FilenameTokens)[],
): FilenameLanguage | undefined {
	const states: FilenameState[] = [{ transitions: [] }];
	let current = 0;
	const append = (characters: string | null, repeat = false) => {
		if (states.length >= 2048) return false;
		const next = states.length;
		states.push({ transitions: [] });
		states[current]?.transitions.push({ to: next, characters });
		if (repeat) states[next]?.transitions.push({ to: next, characters });
		current = next;
		return true;
	};
	for (const { value: pattern, policyTokens, randomTokens } of parts) {
		for (let at = 0; at < pattern.length; ) {
			const numeric = policyTokens
				? /^%([a-zA-Z]+)%/.exec(pattern.slice(at))
				: null;
			if (numeric) {
				// Unknown provider tokens may expand to any non-directory filename text.
				const characters = numeric[1] === "number" ? DIGITS : null;
				if (!append(characters, true)) return undefined;
				at += numeric[0].length;
				continue;
			}
			const random = randomTokens
				? /^\{(?:segment_)?rand_chars(?::([^{}]*))?\}/.exec(pattern.slice(at))
				: null;
			if (random) {
				const length = random[1] === undefined ? 32 : Number(random[1]);
				if (
					(random[1] !== undefined && !/^[1-9]\d*$/.test(random[1])) ||
					!Number.isSafeInteger(length) ||
					length > 2048
				)
					return undefined;
				for (let i = 0; i < length; i++)
					if (!append(ALPHANUMERIC)) return undefined;
				at += random[0].length;
				continue;
			}
			if (!append(pattern[at] ?? "")) return undefined;
			at++;
		}
	}
	return { states, end: current };
}

export type FilenameMembership = "MATCH" | "NO_MATCH" | "UNVERIFIED";

/** Runtime evidence requires MATCH; unlike collision admission, unknown is not proof. */
export function createFilenameMatcher(
	pattern: string,
	options: FilenameTokens,
): (filename: string) => FilenameMembership {
	const language = filenameLanguage([
		{
			value: pattern,
			...options,
		},
	]);
	return (filename) => {
		if (!language) return "UNVERIFIED";
		let active = new Set([0]);
		let steps = 0;
		for (let at = 0; at < filename.length; at++) {
			const next = new Set<number>();
			const character = filename.charAt(at);
			for (const state of active) {
				for (const transition of language.states[state]?.transitions ?? []) {
					if (++steps > 50_000) return "UNVERIFIED";
					if (
						transition.characters === null
							? character !== "/"
							: transition.characters.includes(character)
					)
						next.add(transition.to);
				}
			}
			if (next.size === 0) return "NO_MATCH";
			active = next;
		}
		return active.has(language.end) ? "MATCH" : "NO_MATCH";
	};
}

export function filenameLanguagesOverlap(
	left: FilenameLanguage | undefined,
	right: FilenameLanguage | undefined,
): boolean {
	// Resource bounds and unknown expansions must never certify disjoint writers.
	if (!left || !right) return true;
	const pending: [number, number][] = [[0, 0]];
	const seen = new Set<number>([0]);
	for (let at = 0; at < pending.length; at++) {
		const pair = pending[at];
		if (!pair) continue;
		const [a, b] = pair;
		if (a === left.end && b === right.end) return true;
		for (const x of left.states[a]?.transitions ?? []) {
			for (const y of right.states[b]?.transitions ?? []) {
				const common =
					x.characters === null
						? y.characters === null || [...y.characters].some((c) => c !== "/")
						: y.characters === null
							? [...x.characters].some((c) => c !== "/")
							: [...x.characters].some((c) => y.characters?.includes(c));
				if (!common) continue;
				const key = x.to * right.states.length + y.to;
				if (seen.has(key)) continue;
				if (seen.size >= 50_000) return true;
				seen.add(key);
				pending.push([x.to, y.to]);
			}
		}
	}
	return false;
}

/** Literal storage keys never expand provider filename tokens. */
export function literalFilenameLanguage(
	path: string,
): FilenameLanguage | undefined {
	return filenameLanguage([
		{ value: path, policyTokens: false, randomTokens: false },
	]);
}

/** Normalize a destination while retaining which components are filename templates. */
export function outputFilenameLanguage(
	directory: string,
	filename: string,
	options: FilenameTokens,
): FilenameLanguage | undefined {
	const components: ({ value: string } & FilenameTokens)[] = [];
	for (const [value, tokens] of [
		[directory, { policyTokens: false, randomTokens: false }],
		[filename, options],
	] as const) {
		for (const part of value.split("/")) {
			if (
				part === ".." &&
				components.length &&
				components.at(-1)?.value !== ".."
			)
				components.pop();
			else if (part && part !== ".")
				components.push({
					value: part,
					...tokens,
				});
		}
	}
	return filenameLanguage(
		components.flatMap((part, i) =>
			i
				? [{ value: "/", policyTokens: false, randomTokens: false }, part]
				: [part],
		),
	);
}
