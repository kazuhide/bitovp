import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { GET } from "@/app/api/auth/session/route";
import { DocumentOrganizationContext } from "@/components/providers";
import type { SessionDto } from "@/lib/auth/dto";
import { SESSION_QUERY_KEY, useSession } from "@/lib/auth/use-session";
import { renderWithQuery } from "@/test/render";
import { GenerationControls } from "./generation-controls";
import { useEditingActor } from "./use-editing-actor";

const mocks = vi.hoisted(() => ({
	api: vi.fn(),
	push: vi.fn(),
	mode: "none" as "none" | "password",
	session: undefined as unknown,
}));
vi.mock("@/lib/api", async (original) => ({
	...(await original<object>()),
	apiFetch: mocks.api,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/lib/auth/config", () => ({
	loadAuthConfig: () => ({
		ok: true,
		settings: {
			mode: mocks.mode,
			sessionSecret: "unit-only-session-secret-never-a-deployment-secret",
		},
	}),
}));
vi.mock("@/lib/auth/provider", () => ({
	resolveProvider: (settings: { mode: string }) => ({
		readiness: () => ({ ready: true }),
		loginKind: settings.mode === "none" ? "disabled" : "password-form",
	}),
}));
vi.mock("@/lib/auth/session", () => ({
	readSessionCookie: () => undefined,
	verifySession: () => ({
		ok: true,
		payload: { mode: "password", exp: 1794000000000, abs: 1794000000000 },
	}),
}));
vi.mock("@/lib/auth/tenancy", () => ({
	listOrganizations: vi.fn(),
	resolveAuthenticatedContext: vi.fn(),
	resolveSessionIdentity: vi.fn(),
}));
vi.mock("./association-review", () => ({
	AssociationReview: ({ onVerified }: { onVerified(value: boolean): void }) => (
		<button type="button" onClick={() => onVerified(true)}>
			Association checked
		</button>
	),
}));
const defaultOrg = "00000000-0000-4000-8000-000000000001",
	otherOrg = "00000000-0000-4000-8000-000000000002";
const actor = "11111111-1111-4111-8111-111111111111",
	otherActor = "22222222-2222-4222-8222-222222222222",
	media = "33333333-3333-4333-8333-333333333333",
	analysis = "44444444-4444-4444-8444-444444444444",
	task = "55555555-5555-4555-8555-555555555555";
const openSession = (mode: "none" | "password" = "none"): SessionDto => ({
	mode,
	configured: true,
	authenticated: true,
	loginKind: mode === "none" ? "disabled" : "password-form",
});
const usersSession = (): SessionDto => ({
	mode: "users",
	configured: true,
	authenticated: true,
	loginKind: "password-form",
	organizationId: defaultOrg,
	actorUserId: actor,
	effectiveUserId: actor,
	role: "OPERATOR",
});
function ObservedActor() {
	const value = useEditingActor();
	const session = useSession();
	return (
		<>
			<output aria-label="Observed actor">{value ?? "blocked"}</output>
			<output aria-label="Session read state">{session.status}</output>
		</>
	);
}
const tree = (organizationId: string | null = defaultOrg) => (
	<DocumentOrganizationContext.Provider value={organizationId ?? undefined}>
		<ObservedActor />
		<GenerationControls
			contentId={actor}
			mediaVersionId={media}
			analysisRevisionId={analysis}
			targetDurationFrames={450}
			renderMode="DRAFT"
			disabled={false}
		/>
	</DocumentOrganizationContext.Provider>
);
const posts = () =>
	mocks.api.mock.calls.filter(([, init]) => init?.method === "POST");
beforeEach(() => {
	mocks.api.mockReset();
	mocks.push.mockReset();
	mocks.mode = "none";
	mocks.session = openSession();
	mocks.api.mockImplementation(async (url: string, init?: RequestInit) => {
		if (url === "/api/auth/session") return mocks.session;
		if (url === "/api/library/media-tasks" && init?.method === "POST")
			return { taskId: task, state: "PENDING", cached: false };
		throw new Error("Unexpected test request");
	});
});

it.each([
	"none",
	"password",
] as const)("resolves the actual %s session response without an organization to the default document and creates a draft", async (mode) => {
	mocks.mode = mode;
	const response = await GET(new Request("http://unit.test/api/auth/session"));
	mocks.session = (await response.json()) as SessionDto;
	expect(mocks.session).toMatchObject({
		mode,
		configured: true,
		authenticated: true,
	});
	expect(mocks.session).not.toHaveProperty("organizationId");
	renderWithQuery(tree());
	await waitFor(() =>
		expect(screen.getByLabelText("Observed actor")).toHaveTextContent(
			JSON.stringify([mode, defaultOrg, null, null]),
		),
	);
	fireEvent.click(screen.getByRole("button", { name: "Association checked" }));
	fireEvent.click(screen.getByRole("button", { name: "Create project" }));
	await waitFor(() =>
		expect(mocks.push).toHaveBeenCalledWith(`/library/generations/${task}`),
	);
	expect(posts()).toHaveLength(1);
	const call = posts()[0];
	if (!call) throw new Error("Missing draft request");
	expect(JSON.parse(String(call[1].body))).toMatchObject({
		mediaVersionId: media,
		analysisRevisionId: analysis,
		parameters: { renderMode: "DRAFT" },
	});
});

it.each([
	{
		name: "none not configured",
		session: { ...openSession(), configured: false },
	},
	{
		name: "password not configured",
		session: { ...openSession("password"), configured: false },
	},
	{
		name: "none not authenticated",
		session: { ...openSession(), authenticated: false },
	},
	{
		name: "password not authenticated",
		session: { ...openSession("password"), authenticated: false },
	},
	{
		name: "none explicitly contradictory organization",
		session: { ...openSession(), organizationId: otherOrg },
	},
	{
		name: "password explicitly contradictory organization",
		session: { ...openSession("password"), organizationId: otherOrg },
	},
	{
		name: "none non-default document",
		session: openSession(),
		documentOrg: otherOrg,
	},
	{
		name: "password non-default document",
		session: openSession("password"),
		documentOrg: otherOrg,
	},
	{
		name: "users missing organization",
		session: { ...usersSession(), organizationId: undefined },
	},
	{
		name: "users missing actor",
		session: { ...usersSession(), actorUserId: undefined },
	},
	{
		name: "users invalid actor",
		session: { ...usersSession(), actorUserId: "invalid" },
	},
	{
		name: "users missing effective actor",
		session: { ...usersSession(), effectiveUserId: undefined },
	},
	{
		name: "organization unavailable",
		session: { ...usersSession(), organizationUnavailable: true },
	},
	{
		name: "impersonation",
		session: { ...usersSession(), isImpersonating: true },
	},
	{
		name: "users document mismatch",
		session: { ...usersSession(), organizationId: otherOrg },
	},
	{
		name: "none explicit null organization",
		session: { ...openSession(), organizationId: null },
	},
	{
		name: "password explicit null organization",
		session: { ...openSession("password"), organizationId: null },
	},
	{
		name: "users missing organization without a document context",
		session: { ...usersSession(), organizationId: undefined },
		documentOrg: null,
	},
	{
		name: "none non-default organization and matching document",
		session: { ...openSession(), organizationId: otherOrg },
		documentOrg: otherOrg,
	},
	{
		name: "password non-default organization and matching document",
		session: { ...openSession("password"), organizationId: otherOrg },
		documentOrg: otherOrg,
	},
	{ name: "session response missing", session: undefined },
])("keeps $name blocked without a draft request", async ({
	session,
	documentOrg,
}) => {
	mocks.session = session;
	renderWithQuery(tree(documentOrg));
	await waitFor(() =>
		expect(screen.getByLabelText("Session read state")).toHaveTextContent(
			session === undefined ? "error" : "success",
		),
	);
	expect(screen.getByLabelText("Observed actor")).toHaveTextContent("blocked");
	fireEvent.click(screen.getByRole("button", { name: "Association checked" }));
	const create = screen.queryByRole("button", { name: "Create project" });
	if (create) {
		expect(create).toBeDisabled();
		fireEvent.click(create);
	}
	expect(posts()).toHaveLength(0);
	expect(mocks.push).not.toHaveBeenCalled();
});

it("keeps a real users-mode viewer from the draft mutation even with a valid actor", async () => {
	mocks.session = { ...usersSession(), role: "VIEWER" };
	renderWithQuery(tree());
	await waitFor(() =>
		expect(screen.getByLabelText("Observed actor")).toHaveTextContent(
			JSON.stringify(["users", defaultOrg, actor, actor]),
		),
	);
	expect(
		screen.queryByRole("button", { name: "Create project" }),
	).not.toBeInTheDocument();
	expect(posts()).toHaveLength(0);
});

it.each([
	"actor",
	"organization",
	"role",
] as const)("fences a late draft response after the observed %s changes", async (boundary) => {
	mocks.session = usersSession();
	let finish!: (value: unknown) => void;
	mocks.api.mockImplementation((url: string, init?: RequestInit) =>
		url === "/api/auth/session"
			? Promise.resolve(mocks.session)
			: init?.method === "POST"
				? new Promise((resolve) => {
						finish = resolve;
					})
				: Promise.reject(new Error("Unexpected request")),
	);
	const view = renderWithQuery(tree());
	await waitFor(() =>
		expect(screen.getByLabelText("Observed actor")).not.toHaveTextContent(
			"blocked",
		),
	);
	fireEvent.click(screen.getByRole("button", { name: "Association checked" }));
	fireEvent.click(screen.getByRole("button", { name: "Create project" }));
	await waitFor(() => expect(posts()).toHaveLength(1));
	const next = {
		...usersSession(),
		...(boundary === "actor"
			? { actorUserId: otherActor, effectiveUserId: otherActor }
			: boundary === "organization"
				? { organizationId: otherOrg }
				: { role: "VIEWER" as const }),
	};
	mocks.session = next;
	await act(async () => {
		view.client.setQueryData(SESSION_QUERY_KEY, next);
	});
	if (boundary === "actor")
		await waitFor(() =>
			expect(screen.getByLabelText("Observed actor")).toHaveTextContent(
				JSON.stringify(["users", defaultOrg, otherActor, otherActor]),
			),
		);
	else if (boundary === "organization")
		await waitFor(() =>
			expect(screen.getByLabelText("Observed actor")).toHaveTextContent(
				"blocked",
			),
		);
	else
		await waitFor(() =>
			expect(
				screen.queryByRole("button", { name: "Create project" }),
			).not.toBeInTheDocument(),
		);
	await act(async () =>
		finish({ taskId: task, state: "PENDING", cached: false }),
	);
	expect(mocks.push).not.toHaveBeenCalled();
	expect(posts()).toHaveLength(1);
});
