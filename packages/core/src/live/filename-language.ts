type FilenameState = {
	transitions: { to: number; characters: string | null }[];
};
export type FilenameLanguage = { states: FilenameState[]; end: number };
const DIGITS = "0123456789";
const ALPHANUMERIC = `${DIGITS}ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz`;

/** A bounded automaton for literals, numeric indices and random template tokens. */
function filenameLanguage(
	parts: readonly { value: string; literal: boolean; template: boolean }[],
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
	for (const { value: pattern, literal, template } of parts) {
		for (let at = 0; at < pattern.length; ) {
			const numeric = literal ? null : /^%([a-zA-Z]+)%/.exec(pattern.slice(at));
			if (numeric) {
				// Unknown provider tokens may expand to any non-directory filename text.
				const characters = ["number", "time"].includes(numeric[1] ?? "")
					? DIGITS
					: null;
				if (!append(characters, true)) return undefined;
				at += numeric[0].length;
				continue;
			}
			const random =
				!literal && template
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
	return filenameLanguage([{ value: path, literal: true, template: false }]);
}

/** Normalize a destination while retaining which components are filename templates. */
export function outputFilenameLanguage(
	directory: string,
	filename: string,
	template: boolean,
): FilenameLanguage | undefined {
	const components: { value: string; literal: boolean; template: boolean }[] =
		[];
	for (const [value, literal] of [
		[directory, true],
		[filename, false],
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
					literal,
					template: !literal && template,
				});
		}
	}
	return filenameLanguage(
		components.flatMap((part, i) =>
			i ? [{ value: "/", literal: true, template: false }, part] : [part],
		),
	);
}
