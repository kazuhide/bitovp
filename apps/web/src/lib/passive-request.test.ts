import { describe, expect, it } from "vitest";
import {
	bindPassiveRequestUrl,
	isLibraryMediaUrl,
	passiveOrganizationBinding,
	passiveRequestPath,
	requestOrganizationId,
} from "./passive-request";

const ORG = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const PATH = "/api/library/sources/00000000-0000-4000-8000-000000000003/media";
const URL_PATH = `${PATH}?key=qc-mp4%3Avideo`;
describe("passive request bindings", () => {
	it("binds native artifact downloads without expanding other download routes", () => {
		const path = `/api/library/artifacts/${ORG}/download`;
		expect(bindPassiveRequestUrl(path, ORG)).toBe(
			`${path}?expectedOrganizationId=${ORG}`,
		);
		expect(
			passiveOrganizationBinding(
				new URL(`${path}?expectedOrganizationId=${ORG}`, "http://localhost"),
				"GET",
			),
		).toEqual({ kind: "bound", organizationId: ORG });
		expect(
			passiveOrganizationBinding(
				new URL(
					`${path}?expectedOrganizationId=${ORG}&expectedOrganizationId=${OTHER}`,
					"http://localhost",
				),
				"GET",
			),
		).toEqual({ kind: "invalid" });
		expect(passiveRequestPath(path, "POST")).toBe(false);
		expect(
			passiveRequestPath(`/api/library/media-versions/${ORG}/download`, "GET"),
		).toBe(false);
		expect(passiveRequestPath(`${path}/extra`, "GET")).toBe(false);
	});
	it.each([
		"media-versions",
		"artifacts",
	])("binds fixed editing %s reads to the document organization", (kind) => {
		const path = `/api/library/${kind}/${ORG}/media`;
		expect(bindPassiveRequestUrl(path, ORG)).toBe(
			`${path}?expectedOrganizationId=${ORG}`,
		);
		expect(
			passiveOrganizationBinding(
				new URL(
					`${path}?expectedOrganizationId=${ORG}&expectedOrganizationId=${OTHER}`,
					"http://localhost",
				),
				"GET",
			),
		).toEqual({ kind: "invalid" });
		expect(passiveRequestPath(path, "POST")).toBe(false);
	});
	it.each([
		"",
		"/media",
	])("binds AISA recording%s reads to the document organization", (suffix) => {
		const path = `/api/live/analyses/00000000-0000-4000-8000-000000000003/recording${suffix}`;
		const value = bindPassiveRequestUrl(
			`${path}?bitmovinAccountId=${ORG}&encodingId=${OTHER}`,
			ORG,
		);
		expect(passiveRequestPath(path, "GET")).toBe(true);
		expect(passiveRequestPath(path, "HEAD")).toBe(true);
		expect(passiveRequestPath(`${path}/extra`, "GET")).toBe(false);
		expect(
			passiveOrganizationBinding(new URL(value, "http://localhost"), "GET"),
		).toEqual({ kind: "bound", organizationId: ORG });
	});
	it("adds a non-secret organization assertion and retains exact object-key identity", () => {
		const value = bindPassiveRequestUrl(URL_PATH, ORG);
		expect(value).toBe(`${URL_PATH}&expectedOrganizationId=${ORG}`);
		expect(isLibraryMediaUrl(value)).toBe(true);
		expect(bindPassiveRequestUrl(value, ORG)).toBe(value);
		expect(
			passiveOrganizationBinding(
				new URL(value, "http://localhost:3100"),
				"HEAD",
			),
		).toEqual({ kind: "bound", organizationId: ORG });
	});
	it.each([
		`http://localhost:3100${URL_PATH}`,
		`//foreign.example${URL_PATH}`,
		`${URL_PATH}#fragment`,
		`/api/credentials?key=video`,
		`${PATH}/extra?key=video`,
		`${URL_PATH}&expectedOrganizationId=${OTHER}`,
		`${URL_PATH}&expectedOrganizationId=${ORG}&expectedOrganizationId=${ORG}`,
	])("refuses unscoped or conflicting URL generation: %s", (value) => {
		expect(() => bindPassiveRequestUrl(value, ORG)).toThrow();
	});
	it.each([
		`${URL_PATH}&extra=value`,
		`${URL_PATH}&key=duplicate`,
		`${URL_PATH}&expectedOrganizationId=invalid`,
	])("does not admit extra query parameters into local diagnostics: %s", (value) =>
		expect(isLibraryMediaUrl(value)).toBe(false));
	it.each([
		"POST",
		"PUT",
		"PATCH",
		"DELETE",
		"OPTIONS",
	])("never grants URL binding to %s", (method) =>
		expect(passiveRequestPath(PATH, method)).toBe(false));
});

it("uses only an authenticated context's valid organization for URL generation", () => {
	expect(requestOrganizationId({ tenant: { organizationId: ORG } })).toBe(ORG);
	expect(() => requestOrganizationId({})).toThrow();
	expect(() =>
		requestOrganizationId({ tenant: { organizationId: "invalid" } }),
	).toThrow();
});
