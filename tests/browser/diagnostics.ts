import type { ConsoleMessage, Page } from "@playwright/test";

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
const documentRoutes = [
	"login",
	"root",
	"vod-new",
	"other",
	"unavailable",
] as const;
const browserErrors = [
	"react-310",
	"react-311",
	"react-321",
	"react-418",
	"react-423",
	"react-other",
	"server-render",
	"missing-translation",
	"module-load",
	"hydration",
	"hooks",
	"query-client",
	"reference-error",
	"type-error",
	"syntax-error",
	"unknown",
] as const;

const sessionCategories = [
	...sessionStates.map((state) => `session-${state}`),
	...phases.flatMap((phase) => [
		...sessionStates.map((state) => `session-${phase}-${state}`),
		...documentRoutes.flatMap((route) =>
			sessionStates.map((state) => `session-${phase}-${route}-${state}`),
		),
	]),
];
const errorCategories = phases.flatMap((phase) =>
	browserErrors.flatMap((error) => [
		`browser-${phase}-${error}`,
		`console-${phase}-${error}`,
	]),
);
export const PHASED_GUI_STATES = [
	"session-post-login-started",
	...sessionCategories,
	...errorCategories,
];
const domCategories = [
	"route-vod-new",
	"route-login",
	"route-setup",
	"route-root",
	"route-other",
	"ready-complete",
	"ready-interactive",
	"ready-loading",
	"ready-unknown",
	"navigation-ok",
	"navigation-error",
	"navigation-unknown",
	...(["html", "rsc", "json", "other", "unknown"] as const).map(
		(kind) => `navigation-content-${kind}`,
	),
	"document-next-error",
	"document-empty",
	"document-app-shell",
	"document-other",
	"organization-visible",
	"organization-attached",
	"organization-missing",
	"content-vod",
	"content-dashboard",
	"content-not-found",
	"content-other",
	"content-empty",
	"wizard-attached",
	"wizard-visible",
	"wizard-missing",
	"wizard-imported",
	"wizard-nav-missing",
	"wizard-nav-hidden",
	"wizard-nav-no-current",
	...Array.from({ length: 8 }, (_, index) => `wizard-step-${index + 1}`),
	"permission-checking",
	"sign-in-required",
	"permission-unverified",
	"permission-denied",
	"permission-none",
	"global-error",
	"alert-visible",
	"diagnostic-unavailable",
];

/** Reserve slots for each structured group inside the unchanged public limits. */
export function selectGuiStates(states: readonly unknown[]): string[] {
	const fixed = states
		.slice(0, 32)
		.filter((state): state is string => typeof state === "string");
	return [
		...fixed.filter((state) => domCategories.includes(state)).slice(0, 10),
		...fixed.filter((state) => errorCategories.includes(state)).slice(0, 4),
		...fixed.filter((state) => sessionCategories.includes(state)).slice(0, 8),
		...(fixed.includes("browser-error") ? ["browser-error"] : []),
		...(fixed.includes("session-post-login-started")
			? ["session-post-login-started"]
			: []),
	];
}

export function classifyNavigationContentType(value: unknown) {
	if (typeof value !== "string" || !value.trim()) return "unknown";
	const mediaType = value.slice(0, 200).split(";", 1)[0]?.trim().toLowerCase();
	if (mediaType === "text/html" || mediaType === "application/xhtml+xml")
		return "html";
	if (mediaType === "text/x-component") return "rsc";
	if (
		mediaType === "application/json" ||
		/^application\/[a-z0-9.+-]+\+json$/.test(mediaType ?? "")
	)
		return "json";
	return "other";
}

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
		if (/An error occurred in the Server Components render/i.test(message))
			return "server-render";
		if (
			/\[i18n\] key |useT must be used inside <LocaleProvider>/i.test(message)
		)
			return "missing-translation";
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
		if (name === "ReferenceError" || /^ReferenceError:/.test(message))
			return "reference-error";
		if (name === "TypeError" || /^TypeError:/.test(message))
			return "type-error";
		if (name === "SyntaxError" || /^SyntaxError:/.test(message))
			return "syntax-error";
	} catch {
		// A failed diagnostic must never replace the original browser failure.
	}
	return "unknown";
}

export type AuthenticationObservations = {
	phase: AuthenticationPhase;
	history: { state: string }[];
	browserErrors: string[];
	postLoginSessionStarted: boolean;
};

export function recordBrowserError(
	observations: AuthenticationObservations,
	error: unknown,
	source: "browser" | "console" = "browser",
) {
	if (observations.browserErrors.length < 4)
		observations.browserErrors.push(
			`${source}-${observations.phase}-${classifyBrowserError(error)}`,
		);
}

export function recordConsoleError(
	observations: AuthenticationObservations,
	message: ConsoleMessage,
) {
	try {
		if (message.type() === "error")
			recordBrowserError(observations, { message: message.text() }, "console");
	} catch {
		recordBrowserError(observations, null, "console");
	}
}

function requestDocumentRoute(
	request: { frame(): { url(): string } },
	origin: string,
) {
	try {
		const document = new URL(request.frame().url());
		if (document.origin !== origin) return "other";
		if (document.pathname === "/login") return "login";
		if (document.pathname === "/") return "root";
		if (document.pathname === "/vod/new") return "vod-new";
		return "other";
	} catch {
		return "unavailable";
	}
}

/** Observe existing requests only; the failing document's cause remains unknown. */
export function observeSessionResponses(page: Page, origin: string) {
	const observations: AuthenticationObservations = {
		phase: "initial-login",
		history: [],
		browserErrors: [],
		postLoginSessionStarted: false,
	};
	const requestContexts = new WeakMap<
		object,
		{ phase: AuthenticationPhase; route: (typeof documentRoutes)[number] }
	>();
	const add = (state: string) => {
		if (observations.history.length >= 8) return;
		const entry = { state };
		observations.history.push(entry);
		return entry;
	};
	const isSession = (url: string) => {
		const parsed = new URL(url);
		return parsed.origin === origin && parsed.pathname === "/api/auth/session";
	};
	page.on("request", (request) => {
		if (!isSession(request.url())) return;
		requestContexts.set(request, {
			phase: observations.phase,
			route: requestDocumentRoute(request, origin),
		});
		if (observations.phase === "post-login")
			observations.postLoginSessionStarted = true;
	});
	page.on("pageerror", (error) => recordBrowserError(observations, error));
	page.on("console", (message) => recordConsoleError(observations, message));
	page.on("response", (response) => {
		const url = new URL(response.url());
		if (
			url.origin === origin &&
			url.pathname === "/api/auth/login" &&
			response.request().method() === "POST" &&
			response.status() === 200
		) {
			observations.phase = "post-login";
			return;
		}
		if (!isSession(response.url())) return;
		const context = requestContexts.get(response.request()) ?? {
			phase: observations.phase,
			route: "unavailable",
		};
		const state = (value: string) =>
			`session-${context.phase}-${context.route}-${value}`;
		const entry = add(
			state(response.status() === 200 ? "pending" : "http-error"),
		);
		if (!entry || response.status() !== 200) return;
		void response
			.json()
			.then((data: unknown) => {
				if (!data || typeof data !== "object") {
					entry.state = state("invalid");
					return;
				}
				const session = data as Record<string, unknown>;
				entry.state = state(
					typeof session.configured !== "boolean" ||
						typeof session.authenticated !== "boolean"
						? "invalid"
						: !session.configured
							? "unconfigured"
							: !session.authenticated
								? "anonymous"
								: session.mode === "users" && session.role === "ADMIN"
									? "admin"
									: "authenticated-other",
				);
			})
			.catch(() => {
				entry.state = state("unreadable");
			});
	});
	page.on("requestfailed", (request) => {
		if (!isSession(request.url())) return;
		const context = requestContexts.get(request) ?? {
			phase: observations.phase,
			route: "unavailable",
		};
		add(`session-${context.phase}-${context.route}-request-failed`);
	});
	return observations;
}
