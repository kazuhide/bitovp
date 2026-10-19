export type AuthenticationPhase = "initial-login" | "post-login";

const phases = ["initial-login", "post-login"] as const;
const sessionStates = [
	"pending",
	"http-error",
	"unreadable",
	"invalid",
	"unconfigured",
	"anonymous",
	"admin",
	"authenticated-other",
	"request-failed",
] as const;
const browserErrors = [
	"react-310",
	"react-311",
	"react-321",
	"react-418",
	"react-423",
	"react-other",
	"module-load",
	"hydration",
	"hooks",
	"query-client",
	"reference-error",
	"type-error",
	"syntax-error",
	"unknown",
] as const;

export const PHASED_GUI_STATES = [
	"session-post-login-started",
	...phases.flatMap((phase) => [
		...sessionStates.map((state) => `session-${phase}-${state}`),
		...browserErrors.map((error) => `browser-${phase}-${error}`),
	]),
];

/** Project original errors to fixed categories; never return their text. */
export function classifyBrowserError(
	error: unknown,
): (typeof browserErrors)[number] {
	try {
		const source = error as { name?: unknown; message?: unknown } | null;
		const name =
			typeof source?.name === "string" ? source.name.slice(0, 80) : "";
		const message =
			typeof source?.message === "string" ? source.message.slice(0, 2000) : "";
		const react = message.match(/Minified React error #(\d{1,3})\b/);
		if (react) {
			if (react[1] === "310") return "react-310";
			if (react[1] === "311") return "react-311";
			if (react[1] === "321") return "react-321";
			if (react[1] === "418") return "react-418";
			if (react[1] === "423") return "react-423";
			return "react-other";
		}
		if (
			/ChunkLoadError|Loading chunk[^\n]*failed|Failed to load (?:chunk|script)|dynamically imported module|Importing a module script failed/i.test(
				`${name} ${message}`,
			)
		)
			return "module-load";
		if (
			/hydration|hydrating|server rendered HTML|text content does not match/i.test(
				message,
			)
		)
			return "hydration";
		if (
			/Invalid hook call|Rendered (?:more|fewer) hooks|change in the order of Hooks/i.test(
				message,
			)
		)
			return "hooks";
		if (/No QueryClient set|use QueryClientProvider to set one/i.test(message))
			return "query-client";
		if (name === "ReferenceError") return "reference-error";
		if (name === "TypeError") return "type-error";
		if (name === "SyntaxError") return "syntax-error";
	} catch {
		// A failed diagnostic must never replace the original browser failure.
	}
	return "unknown";
}
