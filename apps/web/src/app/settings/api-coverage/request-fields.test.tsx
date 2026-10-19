import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { messagesFor } from "@/lib/i18n";
import { renderLocalized } from "@/test/render";
import { type RequestFieldInventory, RequestFields } from "./request-fields";

function inventory(): RequestFieldInventory {
	return {
		method: "sdk-body-properties-and-direct-source-keys-v1",
		scope: "encoding-operation-top-level-body-properties",
		summary: {
			bodyOperations: 2,
			expandedOperations: 1,
			unexpandedOperations: 1,
			totalFields: 2,
			sourceAssigned: 1,
			unconfirmed: 1,
		},
		operations: [
			{
				sdkMethod: "encoding.configurations.video.av1.create",
				path: "/encoding/configurations/video/av1",
				httpVerb: "POST",
				bodyParameterIndex: 0,
				bodyModel: "Av1VideoConfiguration",
				expansion: "expanded",
				fields: [
					{
						name: "presetConfiguration",
						type: "Av1PresetConfiguration",
						sdkEvidence: {
							file: "sdk/models/Av1VideoConfiguration.ts",
							line: 27,
						},
						status: "source-assigned",
						evidence: [
							{
								file: "apps/worker/src/orchestrator/ops/configs.ts",
								line: 370,
							},
						],
					},
					{
						name: "dynamicRangeFormat",
						type: "Av1DynamicRangeFormat",
						sdkEvidence: {
							file: "sdk/models/Av1VideoConfiguration.ts",
							line: 45,
						},
						status: "unconfirmed",
						evidence: [],
					},
				],
			},
			{
				sdkMethod: "encoding.encodings.customdata.update",
				path: "/encoding/encodings/{encoding_id}/customData",
				httpVerb: "PUT",
				bodyParameterIndex: 1,
				bodyModel: "object | string",
				expansion: "unexpanded",
				reason: "union-body",
				fields: [],
			},
		],
	};
}

function openInventory() {
	const details = screen.getByTestId("request-field-inventory");
	const summary = details.querySelector("summary");
	if (!summary) throw new Error("Missing native disclosure control");
	fireEvent.click(summary);
	return details;
}

describe("current SDK request-field inventory", () => {
	for (const locale of ["en", "ja"] as const) {
		it.each([
			[
				"array-body",
				"The request body is an array.",
				"本文が配列になっています。",
			],
			[
				"unknown-body",
				"No concrete body type is declared.",
				"本文の具体的な型が宣言されていません。",
			],
			[
				"union-body",
				"The body accepts several possible types.",
				"本文の型に複数の候補があります。",
			],
			[
				"dictionary-body",
				"The body uses arbitrary property names.",
				"本文の属性名が固定されていません。",
			],
			[
				"unsupported-body",
				"This body type is outside the current extraction scope.",
				"この本文の型は、現在の属性抽出の対象外です。",
			],
			[
				"future-body-code",
				"No expanded model is available.",
				"展開済みのモデルがありません。",
			],
			[
				undefined,
				"No expanded model is available.",
				"展開済みのモデルがありません。",
			],
		] as const)(`explains reason %s without exposing opaque codes (${locale})`, (reason, english, japanese) => {
			const data = inventory();
			const body = data.operations[1];
			if (!body) throw new Error("Missing unexpanded fixture");
			body.reason = reason;
			renderLocalized(<RequestFields inventory={data} />, locale);
			openInventory();
			const list = screen.getByTestId("request-bodies-unexpanded");
			const explanation = locale === "en" ? english : japanese;
			expect(list).toHaveTextContent(explanation);
			if (reason) {
				expect(list).not.toHaveTextContent(reason);
				fireEvent.change(
					screen.getByRole("textbox", {
						name:
							locale === "en"
								? "Search request properties"
								: "リクエスト属性を検索",
					}),
					{ target: { value: reason } },
				);
				expect(within(list).getAllByRole("listitem")).toHaveLength(1);
				expect(list).toHaveTextContent(explanation);
			}
		});
	}
	it.each([
		"en",
		"ja",
	] as const)("localizes scope and static-evidence limits (%s)", (locale) => {
		renderLocalized(<RequestFields inventory={inventory()} />, locale);
		const details = screen.getByTestId("request-field-inventory");
		expect(details.tagName).toBe("DETAILS");
		expect(details).not.toHaveAttribute("open");
		openInventory();
		expect(details).toHaveTextContent(
			locale === "en" ? /top-level.*per operation/i : /最上位.*操作ごと/,
		);
		expect(details).toHaveTextContent(
			locale === "en"
				? /not every property is writable/
				: /すべてが書き込み可能とは限りません/,
		);
		expect(details).toHaveTextContent(
			locale === "en" ? /optional or undefined/ : /省略可能・undefined/,
		);
		expect(details).toHaveTextContent(
			locale === "en"
				? /not prove GUI access or actual transmission/
				: /画面からの設定や実際の送信を保証しません/,
		);
		expect(details).toHaveTextContent(
			locale === "en"
				? /unconfirmed does not mean unimplemented/i
				: /未確認.*未実装.*意味しません/,
		);
		expect(details).not.toHaveTextContent("%");
		expect(
			within(details).getByText(messagesFor(locale).apiCoverage.unconfirmed),
		).toBeInTheDocument();
		fireEvent.change(
			screen.getByRole("textbox", {
				name:
					locale === "en"
						? "Search request properties"
						: "リクエスト属性を検索",
			}),
			{ target: { value: "no-matching-property" } },
		);
		expect(screen.getByRole("status")).toHaveTextContent(
			locale === "en"
				? "No request properties match"
				: "条件に一致するリクエスト属性はありません。",
		);
	});

	it("keeps the native disclosure focusable and delegates opening to summary", async () => {
		const user = userEvent.setup();
		renderLocalized(<RequestFields inventory={inventory()} />);
		const details = screen.getByTestId("request-field-inventory");
		const summary = details.querySelector("summary");
		if (!summary) throw new Error("Missing summary");
		// user-event's tab selector omits summary; jsdom checks native focusability.
		summary.focus();
		expect(summary).toHaveFocus();
		expect(details).not.toHaveAttribute("open");
		await user.click(summary);
		expect(details).toHaveAttribute("open");
		await user.click(summary);
		expect(details).not.toHaveAttribute("open");
	});

	it.each([
		["PRESETCONFIG", 1],
		["Av1PresetConfiguration", 1],
		["Av1VideoConfiguration", 2],
		["POST /encoding/configurations/video/av1", 2],
		["ops/configs.ts:370", 1],
		["sdk/models/Av1VideoConfiguration.ts:27", 1],
	] as const)("searches field names, types, models, API calls and evidence: %s", (query, matches) => {
		renderLocalized(<RequestFields inventory={inventory()} />);
		openInventory();
		fireEvent.change(
			screen.getByRole("textbox", { name: "Search request properties" }),
			{
				target: { value: query },
			},
		);
		expect(
			within(screen.getByTestId("request-fields-table")).getAllByRole("row"),
		).toHaveLength(matches + 1);
	});

	it("limits property rows to 50 and returns to the first page on search", () => {
		const data = inventory();
		const operation = data.operations[0];
		const field = operation?.fields[0];
		if (!operation || !field) throw new Error("Missing field fixture");
		operation.fields = Array.from({ length: 52 }, (_, i) => ({
			...field,
			name: `field_${i}`,
		}));
		data.summary.totalFields = 52;
		data.summary.sourceAssigned = 52;
		data.summary.unconfirmed = 0;
		renderLocalized(<RequestFields inventory={data} />);
		openInventory();
		const table = screen.getByTestId("request-fields-table");
		expect(within(table).getAllByRole("row")).toHaveLength(51);
		expect(within(table).queryByText("field_50")).not.toBeInTheDocument();
		fireEvent.click(
			screen.getByRole("button", { name: "Next request properties page" }),
		);
		expect(within(table).getAllByRole("row")).toHaveLength(3);
		expect(within(table).getByText("field_51")).toBeInTheDocument();
		fireEvent.change(
			screen.getByRole("textbox", { name: "Search request properties" }),
			{ target: { value: "field_0" } },
		);
		expect(within(table).getByText("field_0")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Previous request properties page" }),
		).toBeDisabled();
	});

	it("lists unexpanded bodies separately with their reason and search result", () => {
		renderLocalized(<RequestFields inventory={inventory()} />);
		openInventory();
		const unexpanded = screen.getByTestId("request-bodies-unexpanded");
		expect(unexpanded).toHaveTextContent(
			"The body accepts several possible types.",
		);
		expect(unexpanded).toHaveTextContent("object | string");
		expect(
			within(screen.getByTestId("request-fields-table")).queryByText(
				"object | string",
			),
		).not.toBeInTheDocument();
		fireEvent.change(
			screen.getByRole("textbox", { name: "Search request properties" }),
			{ target: { value: "customData" } },
		);
		expect(unexpanded).toHaveTextContent(
			"encoding.encodings.customdata.update",
		);
		expect(screen.getByRole("status")).toHaveTextContent(
			"No request properties match",
		);
	});
	it("bounds the unexpanded-body list and keeps missing reasons explicit", () => {
		const data = inventory();
		const body = data.operations[1];
		if (!body) throw new Error("Missing unexpanded fixture");
		data.operations = Array.from({ length: 52 }, (_, i) => ({
			...body,
			sdkMethod: `encoding.customdata.update_${i}`,
			reason: undefined,
		}));
		data.summary = {
			bodyOperations: 52,
			expandedOperations: 0,
			unexpandedOperations: 52,
			totalFields: 0,
			sourceAssigned: 0,
			unconfirmed: 0,
		};
		renderLocalized(<RequestFields inventory={data} />);
		openInventory();
		const list = screen.getByTestId("request-bodies-unexpanded");
		expect(within(list).getAllByRole("listitem")).toHaveLength(50);
		expect(
			within(list).getAllByText(/No expanded model is available/),
		).toHaveLength(50);
		fireEvent.click(
			screen.getByRole("button", { name: "Next unexpanded bodies page" }),
		);
		expect(within(list).getAllByRole("listitem")).toHaveLength(2);
		fireEvent.change(
			screen.getByRole("textbox", { name: "Search request properties" }),
			{
				target: { value: "update_0" },
			},
		);
		expect(
			within(list).getByText("encoding.customdata.update_0"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Previous unexpanded bodies page" }),
		).toBeDisabled();
	});
});
