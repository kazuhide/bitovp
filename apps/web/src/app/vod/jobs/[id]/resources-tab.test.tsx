import type { StepLogEntry } from "@bitovp/core";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import { anchorId, ResourcesTab } from "./resources-tab";

/**
 *  item 10: the persisted snapshots open IN PLACE. The tab had no
 * test at all; this pins the new expander (present when a snapshot exists,
 * absent when neither does) and that each body renders under ITS OWN label —
 * presence alone survived the request/response swap (review-178 I2/M3).
 * Typed, not `as unknown as`: the cast is the escape hatch that let #177's
 * fixture pin a defect (review-178 N1).
 */

const ENTRIES: StepLogEntry[] = [
	{
		step: "input:main",
		kind: "CREATE_INPUT_S3",
		payload: { name: "in", bucketName: "b", credentialId: "c" },
		refs: {},
		status: "DONE",
		resourceId: "in-123",
		request: { name: "in", bucketName: "b" },
		response: { id: "in-123" },
	},
	{
		step: "await:enc",
		kind: "AWAIT_ENCODING",
		payload: {},
		refs: { encodingId: "encoding" },
		status: "PENDING",
	},
];

describe("anchorId — injective over the key alphabet (review-181 F1)", () => {
	it("the measured collision pair now maps to distinct ids", () => {
		// The first 'injective' fix kept a one-char separator and review-181
		// measured filter:v_:x ≡ filter:v:_x. The two-char '_-' separator is
		// unforgeable by escaping (a literal '_-' encodes to '__-').
		expect(anchorId("filter:v_:x")).not.toBe(anchorId("filter:v:_x"));
		expect(anchorId("stream:v1080")).toBe("resource-stream_-v1080");
	});
});

describe("ResourcesTab — raw snapshots in place", () => {
	it.each([
		"en",
		"ja",
	] as const)("explains why vault-backed DRM requests cannot be copied in %s", (locale) => {
		const entry: StepLogEntry = {
			step: "drm:video",
			kind: "CREATE_DRM_CENC",
			status: "DONE",
			payload: { muxingKind: "FMP4", credentialId: "vault-reference" },
			refs: { encodingId: "encoding", muxingId: "muxing" },
			request: {
				muxingKind: "FMP4",
				refs: { encodingId: "encoding-id", muxingId: "muxing-id" },
			},
		};
		renderLocalized(<ResourcesTab entries={[entry]} />, locale);
		const unavailable = screen.getByText(
			locale === "ja" ? "cURL は利用できません" : "cURL unavailable",
		);
		expect(unavailable).toHaveAttribute(
			"title",
			locale === "ja"
				? "暗号化の作成には保存済みの鍵が必要です。履歴には鍵を含めていないため、cURL は利用できません。"
				: "Encryption keys and key-server credentials are omitted from saved logs, so this request cannot be copied as cURL.",
		);
	});
	it.each([
		"en",
		"ja",
	] as const)("%s: does not offer cURL for an older signed VTT URL", (locale) => {
		const entry: StepLogEntry = {
			step: "external-subtitle",
			kind: "CREATE_HLS_VTT_MEDIA",
			status: "DONE",
			payload: {},
			refs: { manifestId: "manifest" },
			request: {
				vttUrl: "https://cdn.example.test/sub.vtt?token=SYNTHETIC_URL_SECRET",
				name: "English",
				groupId: "subtitles",
				uri: "subtitles.m3u8",
				refs: { manifestId: "manifest-id" },
			},
		};
		renderLocalized(<ResourcesTab entries={[entry]} />, locale);
		expect(
			screen.getByTitle(
				locale === "en"
					? "Use a public URL without credentials, query strings (?) or fragments (#). Signed URLs are not supported."
					: "認証不要の公開URLのみ（署名・?・#は不可）",
			),
		).toHaveTextContent(
			locale === "en" ? "cURL unavailable" : "cURL は利用できません",
		);
		expect(screen.queryByRole("button", { name: /cURL/ })).toBeNull();
	});
	it("opens the persisted request/response, each body under ITS label", async () => {
		renderLocalized(<ResourcesTab entries={ENTRIES} />);
		await userEvent.click(
			screen.getByRole("button", { name: "Raw request/response" }),
		);
		const dialog = screen.getByRole("dialog", {
			name: /input:main.*snapshots/,
		});
		// ASSOCIATION, not presence: swapping the two bodies under their
		// labels kept both blob-is-somewhere assertions green (review-178 M3).
		const req = within(dialog).getByText("Request").parentElement;
		const reqBody = within(req as HTMLElement).getByText(/"bucketName": "b"/);
		expect(reqBody).toBeInTheDocument();
		expect(reqBody.className).toContain("select-all");
		const res = within(dialog).getByText("Response").parentElement;
		expect(
			within(res as HTMLElement).getByText(/"id": "in-123"/),
		).toBeInTheDocument();
		expect(
			within(res as HTMLElement).queryByText(/"bucketName": "b"/),
		).toBeNull();
	});

	it("offers NO expander for a step without snapshots", () => {
		renderLocalized(<ResourcesTab entries={[ENTRIES[1] as StepLogEntry]} />);
		expect(
			screen.queryByRole("button", { name: "Raw request/response" }),
		).toBeNull();
	});

	it("a FAILED await with ONLY a response still opens — the stopped-siblings statement", async () => {
		// The real one-sided shape: the orchestrator's catch branch persists
		// response (stoppedSiblings) with no request. `&&` in the guard
		// survived the original pair of tests (review-178 I3/M5).
		const failed: StepLogEntry = {
			...(ENTRIES[1] as StepLogEntry),
			status: "FAILED",
			response: { stoppedSiblings: ["enc-2"] },
		};
		renderLocalized(<ResourcesTab entries={[failed]} />);
		await userEvent.click(
			screen.getByRole("button", { name: "Raw request/response" }),
		);
		const dialog = screen.getByRole("dialog", { name: /await:enc.*snapshots/ });
		expect(within(dialog).getByText(/"stoppedSiblings"/)).toBeInTheDocument();
		expect(within(dialog).queryByText("Request")).toBeNull();
	});
});
