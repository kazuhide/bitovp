import type { ManifestPlaybackLink } from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ExportButtons } from "@/app/qc/[id]/export-buttons";
import { PreviewRail } from "@/app/vod/jobs/[id]/preview-rail";
import { StoragePanel } from "@/app/vod/jobs/[id]/storage-panel";
import { OpPayloadPopover } from "@/components/op-payload-popover";
import { renderLocalized as render } from "@/test/render";

// The real surface dynamically imports hls.js/Shaka Player against a jsdom
// <video> — stub it; the rail's selection logic is what this batch pins.
vi.mock("@/app/vod/jobs/[id]/playback-surface", () => ({
	PlaybackSurface: ({ url }: { url: string | null }) => (
		<div data-testid="surface" data-url={url ?? ""} />
	),
	FIRST_SEGMENT_ATTEMPTS: 12,
}));

/**
 * Battery batch 2f : the job-detail right rail and storage
 * panel, plus two QC atoms. The rail's Enlarge-opens-what-is-SHOWING rule
 * is a fixed regression (review question C): switch the preview to DASH,
 * click Enlarge, and the dialog must receive DASH — not `playable[0]`.
 */

const link = (
	key: string,
	kind: "HLS" | "DASH",
	url: string | null,
): ManifestPlaybackLink =>
	({
		key,
		kind,
		label: key,
		url,
		path: `/out/${key}`,
		via: url === null ? "none" : "derived",
	}) satisfies ManifestPlaybackLink;

describe("PreviewRail (ledger #149 batch 2f)", () => {
	it("renders nothing at all for a job with no manifests", () => {
		const { container } = render(
			<PreviewRail
				jobId="job-1"
				links={[]}
				playable={[]}
				playableKeys={new Set()}
				live={false}
				showPlayer
			/>,
		);
		// The review finding this pins: an empty labelled aside is an announced
		// region containing nothing.
		expect(container.querySelector("aside")).toBeNull();
	});

	it("Enlarge opens the manifest currently SHOWING, not playable[0]", () => {
		const hls = link("hls", "HLS", "https://cdn/master.m3u8");
		const dash = link("dash", "DASH", "https://cdn/stream.mpd");
		const onPlay = vi.fn();
		render(
			<PreviewRail
				jobId="job-1"
				links={[hls, dash]}
				playable={[hls, dash]}
				playableKeys={new Set(["hls", "dash"])}
				live={false}
				onPlay={onPlay}
				showPlayer
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "DASH · dash" }));
		fireEvent.click(screen.getByRole("button", { name: "Enlarge" }));
		expect(onPlay).toHaveBeenCalledWith(dash);
	});
});

describe("StoragePanel (ledger #149 batch 2f)", () => {
	const summaries = {
		inputs: [
			{
				key: "in-main",
				kind: "S3",
				location: "src-bucket",
				credentialId: "cred-1",
				paths: [],
			},
		],
		outputs: [
			{
				key: "out-main",
				kind: "GENERIC_S3",
				location: "dst-bucket",
				credentialId: "cred-gone",
				paths: [
					{
						path: "/out/hls/master.m3u8",
						role: "manifest" as const,
						key: "hls",
						templated: false,
					},
				],
			},
		],
	};

	it("labels credentials from the refs and says when one is deleted", () => {
		render(
			<StoragePanel
				summaries={summaries}
				credentialRefs={{ "cred-1": { label: "vault-in", provider: "S3" } }}
			/>,
		);
		expect(screen.getByText("vault-in (S3)")).toBeInTheDocument();
		// The output's credential is not in the refs — a deleted credential must
		// be SAID, not rendered as an empty gap.
		expect(screen.getByText("deleted credential")).toBeInTheDocument();
		// Paths remain copyable; playback belongs to the preview rail.
		expect(screen.getByText("/out/hls/master.m3u8")).toBeInTheDocument();
		expect(screen.queryByText("playable")).not.toBeInTheDocument();
	});
});

describe("QC atoms (ledger #149 batch 2f)", () => {
	it("ExportButtons carry the result-scoped export URLs", () => {
		render(<ExportButtons jobId="vmaf-1" resultId="res-2" />);
		const hrefs = [...document.querySelectorAll("a")].map((a) =>
			a.getAttribute("href"),
		);
		expect(
			hrefs.every((h) => h?.startsWith("/api/vmaf-jobs/vmaf-1/export")),
		).toBe(true);
		expect(hrefs.some((h) => h?.includes("result=res-2"))).toBe(true);
	});

	it("OpPayloadPopover reveals the compiled payload on demand", () => {
		render(
			<OpPayloadPopover
				op={{
					step: "enc-1",
					kind: "CREATE_ENCODING",
					payload: { name: "job" },
					refs: {},
				}}
			/>,
		);
		fireEvent.click(screen.getByText("CREATE_ENCODING"));
		expect(screen.getByText(/"name": "job"/)).toBeInTheDocument();
	});
});
