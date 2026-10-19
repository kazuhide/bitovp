import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/lib/i18n";
import { renderWithQuery } from "@/test/render";
import { ApiCoverageClient } from "./coverage-client";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

function payload() {
	return {
		sdk: { installed: "1.280.0", surveyed: "1.280.0", stale: false },
		current: {
			schemaVersion: 1,
			provenance: {
				generatedAt: "2026-09-07T12:00:00Z",
				sourceCommit: "a".repeat(40),
				sourceFingerprint: "b".repeat(64),
				sdkVersion: "1.280.0",
				sdkFingerprint: "c".repeat(64),
				method: "typescript-resolved-sdk-signatures-v1",
				scope: "encoding",
			},
			summary: {
				totalOperations: 3,
				sourceConfirmed: 1,
				unconfirmed: 2,
				createTotal: 2,
				createSourceConfirmed: 1,
			},
			families: [
				{ family: "inputs", total: 2, sourceConfirmed: 1, unconfirmed: 1 },
				{ family: "outputs", total: 1, sourceConfirmed: 0, unconfirmed: 1 },
			],
			endpoints: [
				{
					path: "/encoding/inputs/rtmp",
					operation: "create",
					httpVerb: "POST",
					sdkMethod: "encoding.inputs.rtmp.create",
					family: "inputs",
					status: "source-confirmed",
					evidence: [{ file: "packages/worker/src/rtmp.ts", line: 42 }],
				},
				{
					path: "/encoding/inputs/rtmp",
					operation: "list",
					httpVerb: "GET",
					sdkMethod: "encoding.inputs.rtmp.list",
					family: "inputs",
					status: "unconfirmed",
					evidence: [],
				},
				{
					path: "/encoding/outputs/s3",
					operation: "create",
					httpVerb: "POST",
					sdkMethod: "encoding.outputs.s3.create",
					family: "outputs",
					status: "unconfirmed",
					evidence: [],
				},
			],
		},
		parameterSnapshot: {
			surveyedSdk: "1.277.0",
			surveyedAt: "2026-08-22",
			paramTotals: {},
			fields: 10,
			operatorReachable: 4,
			paramFamilies: [
				{
					family: "inputs",
					fields: 10,
					wizard: 3,
					advanced: 1,
					rawJson: 0,
					autoDerived: 2,
					hardcoded: 0,
					notSettable: 4,
				},
			],
		},
	};
}
beforeEach(() => {
	vi.clearAllMocks();
	apiFetch.mockResolvedValue(payload());
});

describe("coverage page heading", () => {
	for (const locale of ["ja", "en"] as const) {
		for (const state of ["loading", "error", "loaded"] as const) {
			it(`keeps the ${locale} page heading visible while ${state}`, async () => {
				if (state === "loading")
					apiFetch.mockReturnValue(new Promise(() => {}));
				else if (state === "error")
					apiFetch.mockRejectedValue(new Error("offline"));
				renderWithQuery(<ApiCoverageClient />, locale);
				if (state === "loaded") await screen.findByTestId("current-notice");
				if (state === "error")
					await screen.findByText(messagesFor(locale).apiCoverage.loadFailed);
				expect(
					screen.getByRole("heading", {
						level: 1,
						name: locale === "ja" ? "API カバレッジ" : "API coverage",
					}),
				).toBeInTheDocument();
			});
		}
	}
});

describe("ApiCoverageClient current source census", () => {
	it("separates fresh verb-specific source evidence from collapsed historical parameters", async () => {
		renderWithQuery(<ApiCoverageClient />);
		await screen.findByText("packages/worker/src/rtmp.ts:42");
		expect(apiFetch).toHaveBeenCalledWith("/api/settings/api-coverage");
		expect(screen.getAllByText("/encoding/inputs/rtmp")).toHaveLength(2);
		expect(screen.getByText("encoding.inputs.rtmp.list")).toBeInTheDocument();
		const historical = screen.getByTestId("parameter-snapshot");
		expect(historical.tagName).toBe("DETAILS");
		expect(historical).not.toHaveAttribute("open");
		for (const text of ["2026-08-22", "1.277.0", "40.0%"])
			expect(historical).toHaveTextContent(text);
		expect(screen.getByText("40.0%").closest("details")).toBe(historical);
		const provenance = screen.getByTestId("current-provenance");
		for (const text of [
			"2026-09-07T12:00:00Z",
			"a".repeat(40),
			"b".repeat(64),
			"c".repeat(64),
		])
			expect(provenance).toHaveTextContent(text);
		expect(screen.getByTestId("sdk-notice")).toHaveTextContent(/match/i);
		expect(screen.getByTestId("current-notice")).toHaveTextContent(/dynamic/i);
		expect(screen.queryByText("Not implemented")).not.toBeInTheDocument();
		expect(
			screen.queryByTestId("request-field-inventory"),
		).not.toBeInTheDocument();
	});
	it("renders the optional current body-model inventory separately from history", async () => {
		const data = payload();
		apiFetch.mockResolvedValue({
			...data,
			current: {
				...data.current,
				requestFields: {
					method: "sdk-body-properties-and-direct-source-keys-v1",
					scope: "encoding-operation-top-level-body-properties",
					summary: {
						bodyOperations: 0,
						expandedOperations: 0,
						unexpandedOperations: 0,
						totalFields: 0,
						sourceAssigned: 0,
						unconfirmed: 0,
					},
					operations: [],
				},
			},
		});
		renderWithQuery(<ApiCoverageClient />);
		const currentFields = await screen.findByTestId("request-field-inventory");
		expect(currentFields).not.toHaveAttribute("open");
		expect(currentFields).toHaveTextContent("SDK request-body properties");
		expect(screen.getByTestId("parameter-snapshot")).not.toContainElement(
			currentFields,
		);
	});
	it("reports SDK mismatch without refreshing historical parameter figures", async () => {
		const data = payload();
		data.sdk = { installed: "1.281.0", surveyed: "1.280.0", stale: true };
		apiFetch.mockResolvedValue(data);
		renderWithQuery(<ApiCoverageClient />);
		const notice = await screen.findByTestId("sdk-notice");
		for (const text of ["1.281.0", "1.280.0"])
			expect(notice).toHaveTextContent(text);
		expect(notice).toHaveTextContent(/differs/);
	});
	it("filters by explicit family and source status", async () => {
		renderWithQuery(<ApiCoverageClient />);
		await screen.findByText("encoding.outputs.s3.create");
		fireEvent.change(screen.getByRole("combobox", { name: "Family" }), {
			target: { value: "inputs" },
		});
		fireEvent.change(screen.getByRole("combobox", { name: "State" }), {
			target: { value: "source-confirmed" },
		});
		expect(screen.getByText("encoding.inputs.rtmp.create")).toBeInTheDocument();
		expect(
			screen.queryByText("encoding.inputs.rtmp.list"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText("encoding.outputs.s3.create"),
		).not.toBeInTheDocument();
	});
	it.each([
		"packages/worker/src/rtmp.ts:42",
		"RTMP.CREATE",
		"POST /encoding/inputs/rtmp",
	])("searches evidence, method and path/verb: %s", async (search) => {
		renderWithQuery(<ApiCoverageClient />);
		await screen.findByText("encoding.outputs.s3.create");
		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: search },
		});
		expect(screen.getByText("encoding.inputs.rtmp.create")).toBeInTheDocument();
		expect(
			screen.queryByText("encoding.inputs.rtmp.list"),
		).not.toBeInTheDocument();
	});
	it("limits to 50 rows and resets pagination on every filter change", async () => {
		const data = payload();
		const first = data.current.endpoints[0];
		if (!first) throw new Error("Missing endpoint fixture");
		data.current.endpoints = Array.from({ length: 52 }, (_, i) => ({
			...first,
			path: `/encoding/inputs/${i}`,
			sdkMethod: `encoding.inputs.${i}.create`,
		}));
		apiFetch.mockResolvedValue(data);
		renderWithQuery(<ApiCoverageClient />);
		await screen.findByText("/encoding/inputs/0");
		expect(
			within(screen.getByTestId("current-endpoints")).getAllByRole("row"),
		).toHaveLength(51);
		for (const [role, name, value] of [
			["textbox", "Search endpoints", "encoding"],
			["combobox", "Family", "inputs"],
			["combobox", "State", "source-confirmed"],
		] as const) {
			fireEvent.click(screen.getByRole("button", { name: "Next" }));
			expect(screen.getByText("/encoding/inputs/51")).toBeInTheDocument();
			fireEvent.change(screen.getByRole(role, { name }), { target: { value } });
			expect(screen.getByText("/encoding/inputs/0")).toBeInTheDocument();
			expect(screen.getByRole("button", { name: "Prev" })).toBeDisabled();
		}
	});
	it.each([
		"en",
		"ja",
	] as const)("localizes notices and empty results (%s)", async (locale) => {
		renderWithQuery(<ApiCoverageClient />, locale);
		await screen.findByTestId("current-provenance");
		expect(screen.getByTestId("current-notice")).toHaveTextContent(
			locale === "en"
				? /not execution or paid validation/
				: /実行検証・課金検証ではありません/,
		);
		expect(screen.getByTestId("parameter-snapshot")).toHaveTextContent(
			locale === "en" ? /not.*refresh/i : /再調査していません/,
		);
		expect(
			screen.getByText(
				locale === "en"
					? "Survey date: 2026-08-22 · SDK: 1.277.0"
					: "調査日: 2026-08-22 · SDK: 1.277.0",
			),
		).toBeInTheDocument();
		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: "nonexistent" },
		});
		expect(screen.getByTestId("no-matches")).toHaveTextContent(
			locale === "en" ? /No endpoints/ : /一致/,
		);
		expect(
			screen
				.getAllByRole("button")
				.every((button) => (button as HTMLButtonElement).disabled),
		).toBe(true);
	});
	it("shows loading without fabricated data", () => {
		apiFetch.mockReturnValue(new Promise(() => {}));
		renderWithQuery(<ApiCoverageClient />);
		expect(
			screen.getByText("Loading the coverage census…"),
		).toBeInTheDocument();
		expect(screen.queryByTestId("current-provenance")).not.toBeInTheDocument();
	});
	it("shows failure without leaking underlying diagnostic", async () => {
		apiFetch.mockRejectedValue(new Error("secret diagnostic"));
		renderWithQuery(<ApiCoverageClient />);
		expect(
			await screen.findByText("Loading the coverage census failed"),
		).toBeInTheDocument();
		expect(screen.queryByText(/secret diagnostic/)).not.toBeInTheDocument();
	});
});
