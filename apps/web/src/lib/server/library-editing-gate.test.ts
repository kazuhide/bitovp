import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContextError } from "@/lib/auth/tenancy";

const mocks = vi.hoisted(() => ({
	backend: vi.fn(),
	context: vi.fn(),
	audit: vi.fn(),
	availability: vi.fn(),
}));
vi.mock("./local-semantic-readiness", () => ({
	readWorkerClipAvailability: mocks.availability,
}));
vi.mock("./context", () => ({ getServerContext: mocks.context }));
vi.mock("./audit", () => ({
	actorFrom: () => "fixture",
	writeAuditLog: mocks.audit,
}));
vi.mock("./library-editing-projects", () => ({
	createEditingProject: mocks.backend,
	readEditingProject: mocks.backend,
	saveEditingDraft: mocks.backend,
	confirmEditingRevision: mocks.backend,
	editingSuggestions: mocks.backend,
}));
vi.mock("./library-editing-renders", () => ({
	readEditingRender: mocks.backend,
	requestEditingRender: mocks.backend,
	cancelEditingRender: mocks.backend,
}));
vi.mock("./library-editing-media", () => ({
	editingEligibility: mocks.backend,
	readEditingMedia: mocks.backend,
	requestEditingMedia: mocks.backend,
	serveEditingObject: mocks.backend,
}));
vi.mock("./library-media-tasks", () => ({
	createMediaTask: mocks.backend,
	listMediaTasks: mocks.backend,
	readMediaTask: mocks.backend,
	retryMediaTask: mocks.backend,
	cancelMediaTask: mocks.backend,
}));
vi.mock("./library-image-assets", () => ({
	createImageAsset: mocks.backend,
	serveImageAsset: mocks.backend,
}));
vi.mock("./library-hierarchy", () => ({
	listEditingProjectSummaries: mocks.backend,
}));
vi.mock("./library-editing-thumbnail", () => ({
	readEditingThumbnailFrame: mocks.backend,
}));
vi.mock("./library-automatic-portrait", () => ({
	createAutomaticPortrait: mocks.backend,
}));
vi.mock("./library-analysis-associations", () => ({
	confirmAnalysisAssociation: mocks.backend,
	inspectAnalysisAssociation: mocks.backend,
}));
vi.mock("./library-composition", () => ({
	compositionSourceFacts: mocks.backend,
}));

import {
	GET as associationGET,
	POST as associationPOST,
} from "@/app/api/library/analysis-associations/route";
import { GET as artifactDownloadGET } from "@/app/api/library/artifacts/[id]/download/route";
import { GET as artifactGET } from "@/app/api/library/artifacts/[id]/media/route";
import { GET as fontGET } from "@/app/api/library/editing-font/route";
import { GET as mediaListGET } from "@/app/api/library/editing-media/route";
import { PUT as draftPUT } from "@/app/api/library/edits/[id]/draft/route";
import { POST as imagePOST } from "@/app/api/library/edits/[id]/images/route";
import { POST as renderPOST } from "@/app/api/library/edits/[id]/renders/route";
import { POST as revisionPOST } from "@/app/api/library/edits/[id]/revisions/route";
import { GET as projectGET } from "@/app/api/library/edits/[id]/route";
import { POST as suggestionPOST } from "@/app/api/library/edits/[id]/suggestions/route";
import { GET as thumbnailGET } from "@/app/api/library/edits/[id]/thumbnail-frame/route";
import {
	GET as editsGET,
	POST as editsPOST,
} from "@/app/api/library/edits/route";
import {
	GET as assetGET,
	HEAD as assetHEAD,
} from "@/app/api/library/image-assets/[id]/media/route";
import { POST as taskCancelPOST } from "@/app/api/library/media-tasks/[id]/cancel/route";
import { POST as taskRetryPOST } from "@/app/api/library/media-tasks/[id]/retry/route";
import { GET as taskGET } from "@/app/api/library/media-tasks/[id]/route";
import {
	GET as taskListGET,
	POST as taskPOST,
} from "@/app/api/library/media-tasks/route";
import { GET as mediaObjectGET } from "@/app/api/library/media-versions/[id]/media/route";
import { GET as mediaGET } from "@/app/api/library/media-versions/[id]/route";
import { POST as portraitPOST } from "@/app/api/library/portrait-generations/route";
import { POST as renderCancelPOST } from "@/app/api/library/renders/[id]/cancel/route";
import { GET as renderGET } from "@/app/api/library/renders/[id]/route";
import { GET as eligibilityGET } from "@/app/api/library/sources/[id]/editing-eligibility/route";
import { POST as preparePOST } from "@/app/api/library/sources/[id]/media-versions/route";
import { editingRoute } from "./library-editing-common";
import { editingMutation } from "./library-editing-routes";

const id = "11111111-1111-4111-8111-111111111111";
const context = { params: Promise.resolve({ id }) };
const keys = [
	"ENABLED",
	"GATEWAY_URL",
	"GATEWAY_TOKEN",
	"CA_FILE",
	"PROFILE",
	"CONFIG_ID",
];
function enable() {
	const values = [
		"1",
		"https://fixture.invalid",
		"fixture-token-".repeat(3),
		"/unused/fixture-ca.pem",
		"nvidia",
		id,
	];
	keys.forEach((key, index) => {
		vi.stubEnv(`BITOVP_LOCAL_SEMANTIC_${key}`, values[index]);
	});
}
beforeEach(() => {
	mocks.availability.mockReset().mockResolvedValue(true);
	for (const key of keys) vi.stubEnv(`BITOVP_LOCAL_SEMANTIC_${key}`, undefined);
	mocks.backend.mockReset().mockResolvedValue({ id });
	mocks.audit.mockReset().mockResolvedValue(undefined);
	mocks.context.mockReset().mockResolvedValue({
		tenant: { organizationId: id },
		prisma: { libraryMediaVersion: { findMany: mocks.backend } },
	});
});
afterEach(() => vi.unstubAllEnvs());
type RouteCase = [string, string, (request: Request) => Promise<Response>];
const allRoutes: RouteCase[] = [
	["edits", "GET", (r) => editsGET(r)],
	["edits", "POST", (r) => editsPOST(r)],
	["edits/id", "GET", (r) => projectGET(r, context)],
	["edits/id/draft", "PUT", (r) => draftPUT(r, context)],
	["edits/id/images", "POST", (r) => imagePOST(r, context)],
	["edits/id/renders", "POST", (r) => renderPOST(r, context)],
	["edits/id/revisions", "POST", (r) => revisionPOST(r, context)],
	["edits/id/suggestions", "POST", (r) => suggestionPOST(r, context)],
	["edits/id/thumbnail-frame", "GET", (r) => thumbnailGET(r, context)],
	["media-tasks", "GET", (r) => taskListGET(r)],
	["media-tasks", "POST", (r) => taskPOST(r)],
	["media-tasks/id", "GET", (r) => taskGET(r, context)],
	["media-tasks/id/retry", "POST", (r) => taskRetryPOST(r, context)],
	["media-versions/id", "GET", (r) => mediaGET(r, context)],
	["media-versions/id/media", "GET", (r) => mediaObjectGET(r, context)],
	["image-assets/id/media", "GET", (r) => assetGET(r, context)],
	["image-assets/id/media", "HEAD", (r) => assetHEAD(r, context)],
	["editing-media", "GET", () => mediaListGET()],
	["editing-font", "GET", () => fontGET()],
	["renders/id", "GET", (r) => renderGET(r, context)],
	["analysis-associations", "GET", (r) => associationGET(r)],
	["analysis-associations", "POST", (r) => associationPOST(r)],
	["sources/id/editing-eligibility", "GET", (r) => eligibilityGET(r, context)],
	["sources/id/media-versions", "POST", (r) => preparePOST(r, context)],
	["portrait-generations", "POST", (r) => portraitPOST(r)],
];
const readRoutes = allRoutes.filter(
	([path, method]) =>
		["GET", "HEAD"].includes(method) && path !== "editing-font",
);
const disabledRoutes = allRoutes.filter(
	([, method]) => !["GET", "HEAD"].includes(method),
);
describe("editing APIs require local configuration before action or body processing", () => {
	it("retains font reads when no GPU is available, reporting only the actual missing font", async () => {
		vi.stubEnv("EDITING_FONT_PATH", undefined);
		const response = await fontGET();
		expect(response.status).toBe(503);
		expect((await response.json()).error).toBe("EDITING_FONT_UNAVAILABLE");
		expect(mocks.availability).not.toHaveBeenCalled();
	});
	it.each(
		readRoutes,
	)("preserves stored %s %s reads while GPU work is unavailable", async (path, method, invoke) => {
		if (path === "editing-media") mocks.backend.mockResolvedValueOnce([]);
		const response = await invoke(
			new Request(`http://localhost/api/library/${path}?contentId=${id}`, {
				method,
			}),
		);
		expect(response.status).toBe(200);
		expect(mocks.backend).toHaveBeenCalled();
		expect(mocks.availability).not.toHaveBeenCalled();
	});
	it("rejects configured but unverified GPU mutations before parsing or backend work", async () => {
		enable();
		mocks.availability.mockResolvedValue(false);
		for (const [path, method, invoke] of disabledRoutes) {
			const req = new Request(`http://localhost/api/library/${path}`, {
				method,
				...(["POST", "PUT"].includes(method)
					? { body: "{malformed-not-read" }
					: {}),
			});
			expect((await invoke(req)).status).toBe(503);
			expect(req.bodyUsed).toBe(false);
		}
		expect(mocks.backend).not.toHaveBeenCalled();
	});
	it.each(
		disabledRoutes,
	)("refuses %s %s with no backend side effects", async (path, method, invoke) => {
		const req = new Request(
			`http://localhost/api/library/${path}?allowUnavailable=CANCEL`,
			{
				method,
				...(method === "POST" || method === "PUT"
					? { body: "{malformed-not-read" }
					: {}),
			},
		);
		const response = await invoke(req);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: "CLIP_EDITING_UNAVAILABLE",
			details: { code: "CLIP_EDITING_UNAVAILABLE" },
		});
		expect(req.bodyUsed).toBe(false);
		expect(mocks.backend).not.toHaveBeenCalled();
		expect(mocks.context).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});
	it("also refuses direct wrapper calls for malformed/partial settings without exposing config", async () => {
		vi.stubEnv("BITOVP_LOCAL_SEMANTIC_ENABLED", "1");
		vi.stubEnv("BITOVP_LOCAL_SEMANTIC_GATEWAY_TOKEN", "private-value");
		const response = await editingMutation(
			new Request("http://localhost/api/library/edits", { method: "POST" }),
			mocks.backend,
			201,
		);
		expect(response.status).toBe(503);
		expect(JSON.stringify(await response.json())).not.toContain(
			"private-value",
		);
		expect(mocks.backend).not.toHaveBeenCalled();
	});
	it("retains enabled editing behavior and the audited mutation boundary", async () => {
		enable();
		const response = await editsPOST(
			new Request("http://localhost/api/library/edits", {
				method: "POST",
				body: JSON.stringify({ fixture: true }),
			}),
		);
		expect(response.status).toBe(201);
		expect(mocks.backend).toHaveBeenCalledWith({ fixture: true }, "fixture");
		expect(mocks.audit).toHaveBeenCalledOnce();
	});
	it.each([
		["media", artifactGET, false],
		["download", artifactDownloadGET, true],
	] as const)("allows existing artifact %s through its original reader when disabled", async (path, invoke, download) => {
		mocks.backend.mockResolvedValueOnce(
			new Response("owned artifact", { status: 200 }),
		);
		const req = new Request(
			`http://localhost/api/library/artifacts/${id}/${path}?expectedOrganizationId=${id}`,
		);
		const response = await invoke(req, context);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("owned artifact");
		expect(mocks.backend).toHaveBeenCalledWith(
			req,
			id,
			"ARTIFACT",
			...(download ? [true] : []),
		);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
	});
	it.each([
		["render", renderCancelPOST, 202],
		["media task", taskCancelPOST, 200],
	] as const)("allows existing %s cancellation and keeps auditing when disabled", async (_, invoke, status) => {
		const req = new Request(`http://localhost/api/library/cancel/${id}`, {
			method: "POST",
		});
		const response = await invoke(req, context);
		expect(response.status).toBe(status);
		expect(mocks.backend).toHaveBeenCalledWith(id);
		expect(mocks.audit).toHaveBeenCalledOnce();
	});
	it("does not turn allowed artifact or cancel operations into an authorization bypass", async () => {
		const denied = async () => {
			throw new AuthContextError(403, "Access denied");
		};
		expect(
			(await editingRoute(denied, 200, { allowUnavailable: "ARTIFACT_READ" }))
				.status,
		).toBe(403);
		expect(
			(
				await editingMutation(
					new Request("http://localhost/cancel", { method: "POST" }),
					denied,
					200,
					{ allowUnavailable: "CANCEL" },
				)
			).status,
		).toBe(403);
		expect(mocks.audit).not.toHaveBeenCalled();
	});
});
