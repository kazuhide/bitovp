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
	"network-refused",
	"network-reset",
	"network-closed",
	"network-empty",
	"network-timeout",
	"network-aborted",
	"network-other",
	"resource-http-404",
	"resource-http-5xx",
	"resource-http-other",
	"resource-load",
	"csp",
	"cors",
	"mime-type",
	"integrity",
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

type LoginFields = Readonly<{ email: string; password: string }>;
const loginFieldCategories = [
	"not-observed",
	"match",
	"mismatch",
	"unreadable",
	"unavailable",
].map((state) => `login-fields-${state}`);
const loginHttpCategories = [
	"not-observed",
	"pending",
	"ok",
	"bad-request",
	"unauthorized",
	"forbidden",
	"conflict",
	"too-large",
	"rate-limited",
	"server-error",
	"unavailable",
	"other-2xx",
	"redirect",
	"other-4xx",
	"other-5xx",
	"other",
	"request-failed",
].map((state) => `login-http-${state}`);
const loginErrorCodes = new Map([
	["AUTH_NOT_CONFIGURED", "not-configured"],
	["AUTH_PROVIDER_UNAVAILABLE", "provider-unavailable"],
	["AUTH_INVALID_CREDENTIALS", "invalid-credentials"],
	["AUTH_PASSWORD_EXPIRED", "password-expired"],
	["AUTH_RATE_LIMITED", "rate-limited"],
	["AUTH_BUSY", "busy"],
	["AUTH_PASSWORD_REQUIRED", "password-required"],
	["AUTH_EMAIL_REQUIRED", "email-required"],
	["AUTH_CREDENTIALS_CHANGED", "credentials-changed"],
	["AUTH_MODE_UNSUPPORTED", "mode-unsupported"],
	["AUTH_PASSWORD_CHANGE_REQUIRED", "password-change-required"],
	["AUTH_SETUP_REQUIRED", "setup-required"],
	["TENANT_IP_DENIED", "tenant-ip-denied"],
	["TENANT_CHANGED", "tenant-changed"],
	["TENANT_MEMBERSHIP_REQUIRED", "tenant-membership-required"],
	["TENANT_IP_INVALID", "tenant-ip-invalid"],
]);
const loginCodeCategories = [
	"not-observed",
	"pending",
	"none",
	"invalid",
	"unreadable",
	"unavailable",
	"other",
	...loginErrorCodes.values(),
].map((state) => `login-code-${state}`);

/** Compare the original POST in memory and retain no submitted or expected values. */
export function classifyLoginFields(body: unknown, expected?: LoginFields) {
	try {
		if (!expected) return "login-fields-unavailable";
		if (!body || typeof body !== "object" || Array.isArray(body))
			return "login-fields-mismatch";
		const fields = body as Record<string, unknown>;
		return fields.email === expected.email &&
			fields.password === expected.password
			? "login-fields-match"
			: "login-fields-mismatch";
	} catch {
		return "login-fields-unreadable";
	}
}

export function classifyLoginStatus(status: unknown) {
	if (typeof status !== "number" || !Number.isInteger(status))
		return "login-http-other";
	const known = new Map([
		[200, "ok"],
		[400, "bad-request"],
		[401, "unauthorized"],
		[403, "forbidden"],
		[409, "conflict"],
		[413, "too-large"],
		[429, "rate-limited"],
		[500, "server-error"],
		[503, "unavailable"],
	]);
	const category =
		known.get(status) ??
		(status >= 200 && status < 300
			? "other-2xx"
			: status >= 300 && status < 400
				? "redirect"
				: status >= 400 && status < 500
					? "other-4xx"
					: status >= 500 && status < 600
						? "other-5xx"
						: "other");
	return `login-http-${category}`;
}

export function classifyLoginCode(body: unknown) {
	try {
		if (!body || typeof body !== "object" || Array.isArray(body))
			return "login-code-invalid";
		const details = (body as Record<string, unknown>).details;
		if (details === undefined) return "login-code-none";
		if (!details || typeof details !== "object" || Array.isArray(details))
			return "login-code-invalid";
		const code = (details as Record<string, unknown>).code;
		return typeof code === "string"
			? `login-code-${loginErrorCodes.get(code) ?? "other"}`
			: "login-code-invalid";
	} catch {
		return "login-code-unreadable";
	}
}

/** Reserve slots for each structured group inside the unchanged public limits. */
export function selectGuiStates(states: readonly unknown[]): string[] {
	const fixed = states
		.slice(0, 32)
		.filter((state): state is string => typeof state === "string");
	const login = fixed.includes("route-login")
		? [loginFieldCategories, loginHttpCategories, loginCodeCategories].flatMap(
				(categories) => {
					const state = fixed.find((value) => categories.includes(value));
					return state ? [state] : [];
				},
			)
		: [];
	const dom = fixed.filter((state) => domCategories.includes(state));
	return [
		...(login.length
			? dom.filter(
					(state) =>
						!state.startsWith("navigation-") && !state.startsWith("wizard-"),
				)
			: dom
		).slice(0, 10 - login.length),
		...login,
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
		if (/Content Security Policy/i.test(message)) return "csp";
		if (
			/blocked by CORS policy|Cross-Origin Request Blocked|Cross-Origin-Resource-Policy/i.test(
				message,
			)
		)
			return "cors";
		if (
			/MIME type|Expected a JavaScript(?:-or-Wasm)? module script/i.test(
				message,
			)
		)
			return "mime-type";
		if (
			/valid digest.*integrity|integrity.*(?:digest|mismatch)|Subresource Integrity/i.test(
				message,
			)
		)
			return "integrity";
		if (
			/ChunkLoadError|Loading (?:CSS )?chunk[^\n]*failed|Failed to load (?:chunk|(?:module )?script)|dynamically imported module|Importing a module script failed/i.test(
				`${name} ${message}`,
			)
		)
			return "module-load";
		if (
			/hydration|hydrating|hydrated|server rendered HTML|text content (?:does|did) not match|Expected server HTML to contain a matching|Did not expect server HTML to contain/i.test(
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
		const network = message.match(/\bnet::(ERR_[A-Z_]{1,64})\b/);
		if (network) {
			const known = new Map<string, (typeof browserErrors)[number]>([
				["ERR_CONNECTION_REFUSED", "network-refused"],
				["ERR_CONNECTION_RESET", "network-reset"],
				["ERR_CONNECTION_CLOSED", "network-closed"],
				["ERR_EMPTY_RESPONSE", "network-empty"],
				["ERR_CONNECTION_TIMED_OUT", "network-timeout"],
				["ERR_TIMED_OUT", "network-timeout"],
				["ERR_ABORTED", "network-aborted"],
			]);
			return known.get(network[1] ?? "") ?? "network-other";
		}
		if (
			/Failed to fetch\b|NetworkError when attempting to fetch resource/i.test(
				message,
			)
		)
			return "network-other";
		const http = message.match(
			/Failed to load resource:[^\n]*status of ([1-5]\d{2})\b/i,
		);
		if (http)
			return http[1] === "404"
				? "resource-http-404"
				: http[1]?.startsWith("5")
					? "resource-http-5xx"
					: "resource-http-other";
		if (/Failed to load resource\b/i.test(message)) return "resource-load";
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
	login: { fields: string; http: string; code: string };
};

export function recordBrowserError(
	observations: AuthenticationObservations,
	error: unknown,
	source: "browser" | "console" = "browser",
) {
	if (observations.browserErrors.length >= 4) return;
	const category = `${source}-${observations.phase}-${classifyBrowserError(error)}`;
	if (!observations.browserErrors.includes(category))
		observations.browserErrors.push(category);
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
export function observeSessionResponses(
	page: Page,
	origin: string,
	expectedLogin?: LoginFields,
) {
	const observations: AuthenticationObservations = {
		phase: "initial-login",
		history: [],
		browserErrors: [],
		postLoginSessionStarted: false,
		login: {
			fields: "login-fields-not-observed",
			http: "login-http-not-observed",
			code: "login-code-not-observed",
		},
	};
	let firstLoginRequest: object | undefined;
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
		const url = new URL(request.url());
		if (
			url.origin === origin &&
			url.pathname === "/api/auth/login" &&
			request.method() === "POST"
		) {
			if (firstLoginRequest) return;
			firstLoginRequest = request;
			try {
				observations.login.fields = classifyLoginFields(
					request.postDataJSON(),
					expectedLogin,
				);
			} catch {
				observations.login.fields = "login-fields-unreadable";
			}
			observations.login.http = "login-http-pending";
			observations.login.code = "login-code-pending";
			return;
		}
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
			response.request().method() === "POST"
		) {
			if (response.status() === 200) observations.phase = "post-login";
			if (firstLoginRequest && firstLoginRequest !== response.request()) return;
			if (!firstLoginRequest) {
				firstLoginRequest = response.request();
				observations.login.fields = "login-fields-unavailable";
			}
			observations.login.http = classifyLoginStatus(response.status());
			observations.login.code = "login-code-pending";
			try {
				void Promise.resolve(response.json())
					.then((body: unknown) => {
						observations.login.code = classifyLoginCode(body);
					})
					.catch(() => {
						observations.login.code = "login-code-unreadable";
					});
			} catch {
				observations.login.code = "login-code-unreadable";
			}
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
		if (
			request === firstLoginRequest &&
			observations.login.http === "login-http-pending"
		) {
			observations.login.http = "login-http-request-failed";
			observations.login.code = "login-code-unavailable";
		}
		if (!isSession(request.url())) return;
		const context = requestContexts.get(request) ?? {
			phase: observations.phase,
			route: "unavailable",
		};
		add(`session-${context.phase}-${context.route}-request-failed`);
	});
	return observations;
}
