import type { ManifestPlaybackLink } from "@bitovp/core";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ManifestList } from "@/components/manifest-list";
import { renderLocalized as renderL } from "@/test/render";

/**
 * The rendering contract of the list both the job page and the channel page use.
 *
 * It exists because extracting it was justified with "the VOD page's 30 tests still
 * pass", which is not the same claim as "the rendering is unchanged" — those tests
 * assert through the page, so a subtle change inside the shared component that no
 * page test happens to look at would have gone unnoticed. This pins the contract
 * itself, at the component.
 */

function link(over: Partial<ManifestPlaybackLink> = {}): ManifestPlaybackLink {
	return {
		key: "hls",
		kind: "HLS",
		label: "HLS manifest",
		url: "https://out.s3.eu-west-1.amazonaws.com/o/stream.m3u8",
		path: "o/stream.m3u8",
		via: "derived",
		...over,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText: vi.fn().mockResolvedValue(undefined) },
	});
});

describe("ManifestList", () => {
	it("renders nothing at all for an empty list", () => {
		const { container } = renderL(
			<ManifestList links={[]} playableKeys={new Set()} />,
		);
		// Not even the heading: a job with no manifests must not grow an empty section.
		expect(container).toBeEmptyDOMElement();
	});

	it("shows the URL when there is one, and the origin path when there is not", () => {
		renderL(
			<ManifestList
				links={[
					link(),
					link({
						key: "private",
						url: null,
						via: "none",
						reason: { code: "NOT_PUBLIC" },
					}),
				]}
				playableKeys={new Set(["hls"])}
			/>,
		);
		expect(screen.getByText(link().url ?? "")).toBeInTheDocument();
		expect(screen.getByText("o/stream.m3u8")).toBeInTheDocument();
	});

	it("copies the URL when there is one and the path when there is not", async () => {
		// `userEvent.setup` installs its own clipboard stub, so the spy has to be
		// defined AFTER it or it is silently replaced and the assertion tests nothing.
		const user = userEvent.setup();
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText },
		});
		renderL(
			<ManifestList
				links={[link({ url: null, via: "none" })]}
				playableKeys={new Set()}
			/>,
		);
		await user.click(
			screen.getByRole("button", {
				name: "Copy the HLS manifest path: o/stream.m3u8",
			}),
		);
		// The path, not an empty string — a copy button that yields "" is worse than
		// no copy button.
		expect(writeText).toHaveBeenCalledWith("o/stream.m3u8");
		await waitFor(() =>
			expect(screen.getByRole("status")).toHaveTextContent("Copied"),
		);
	});

	it("gives every copy button a target-specific accessible name", () => {
		renderL(
			<ManifestList
				links={[
					link(),
					link({
						key: "dash",
						kind: "DASH",
						label: "DASH manifest",
						url: "https://out.example.test/o/stream.mpd",
						path: "o/stream.mpd",
					}),
				]}
				playableKeys={new Set()}
			/>,
		);

		expect(
			screen.getByRole("button", {
				name: `Copy the HLS manifest URL: ${link().url}`,
			}),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name: "Copy the DASH manifest URL: https://out.example.test/o/stream.mpd",
			}),
		).toBeInTheDocument();
	});

	it("renders the reason, localised, when a link carries one", () => {
		renderL(
			<ManifestList
				links={[
					link({ url: null, via: "none", reason: { code: "NOT_PUBLIC" } }),
				]}
				playableKeys={new Set()}
			/>,
			"ja",
		);
		expect(screen.getByText(/出力のACLが非公開/)).toBeInTheDocument();
	});

	/**
	 * The MSL not-configured reason (2026-09-02) is the one whose remedy is a
	 * single field on a single settings row, so it carries the way there. No
	 * other reason grows a link — the negative arm keeps that so.
	 */
	it("links to the credentials page beside the MSL not-configured reason, and only there", () => {
		renderL(
			<ManifestList
				links={[
					link({
						key: "msl",
						url: null,
						path: "msl/stream.m3u8",
						via: "none",
						reason: {
							code: "MSL_EDGE_URL_NOT_CONFIGURED",
							credentialId: "00000000-0000-4000-8000-000000000003",
						},
					}),
					link({
						key: "private",
						url: null,
						path: "private/stream.m3u8",
						via: "none",
						reason: { code: "NOT_PUBLIC" },
					}),
				]}
				playableKeys={new Set()}
			/>,
			"ja",
		);
		expect(
			screen.getByText(/配信エッジのベース URL が登録されていない/),
		).toBeInTheDocument();
		const links = screen.getAllByRole("link", { name: "認証情報を開く" });
		expect(links).toHaveLength(1);
		expect(links[0]).toHaveAttribute("href", "/settings/credentials");
		// The link belongs to the MSL row, not the private one — by relation.
		const mslRow = screen.getByText("msl/stream.m3u8").closest("li");
		const privateRow = screen.getByText("private/stream.m3u8").closest("li");
		expect(mslRow).toContainElement(links[0] as HTMLElement);
		expect(privateRow).not.toContainElement(links[0] as HTMLElement);
	});

	it("shows an MSL edge link as a plain URL with no reason and no link out", () => {
		renderL(
			<ManifestList
				links={[
					link({
						url: "https://bitmovinmsl4hlsjp.akamaized.net/hls/live/2126636/ev/stream.m3u8",
						via: "credential-edge",
					}),
				]}
				playableKeys={new Set()}
			/>,
		);
		expect(
			screen.getByText(
				"https://bitmovinmsl4hlsjp.akamaized.net/hls/live/2126636/ev/stream.m3u8",
			),
		).toBeInTheDocument();
		expect(screen.queryByRole("link")).toBeNull();
	});

	it("offers Play only when the link is playable AND the page can open one", async () => {
		const onPlay = vi.fn();
		const { unmount } = renderL(
			<ManifestList
				links={[link()]}
				playableKeys={new Set(["hls"])}
				onPlay={onPlay}
			/>,
		);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Play" }));
		expect(onPlay).toHaveBeenCalledWith(
			expect.objectContaining({ key: "hls" }),
		);
		unmount();

		// Playable, but the page has no enlarged view — the live channel page.
		renderL(<ManifestList links={[link()]} playableKeys={new Set(["hls"])} />);
		expect(screen.queryByRole("button", { name: "Play" })).toBeNull();
	});

	it("withholds Play for a link the caller did not mark playable", () => {
		// The caller owns the C1/ACL/SMOOTH rules; this component must not guess.
		renderL(
			<ManifestList
				links={[link({ reason: { code: "INSECURE_ENDPOINT" } })]}
				playableKeys={new Set()}
				onPlay={vi.fn()}
			/>,
		);
		expect(screen.queryByRole("button", { name: "Play" })).toBeNull();
		// …but the URL is still there to copy.
		expect(screen.getByText(link().url ?? "")).toBeInTheDocument();
	});
});
