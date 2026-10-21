import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import type { VmafResultDetail } from "../vmaf-shared";
import { VmafContextBanner } from "./vmaf-context-banner";

/**
 * The banner rendered, not just the pure function tested.
 *
 * `vmaf-context.test.ts` proves the judgements; this proves they reach the screen. Both
 * are needed, and neither is a substitute for opening the page: the QC report fetches
 * client-side, so a server-rendered HTML fetch shows none of this — the same shape as
 * the 21 wrong `<title>`s that passed 3,187 tests because jsdom renders components, not
 * document metadata. What jsdom DOES settle is that the right sentences appear.
 */

/** The real report: mean 16.77, 106 of 217 frames at zero, harmonic mean collapsed. */
function degenerateResult(height: number, bitrate: number): VmafResultDetail {
	return {
		id: `r-${height}`,
		renditionRef: { height, bitrate, codec: "H264" },
		pooled: {
			mean: 16.77047859447005,
			min: 0,
			max: 76.799006,
			harmonicMean: 0,
			low1Percent: 0,
			percentiles: { p1: 0, p5: 0, p10: 0, p25: 0, p50: 2.854175 },
			worstFrame: { frameNum: 43, vmaf: 0 },
		},
		frames: [
			...Array.from({ length: 106 }, (_, i) => ({ frameNum: i, vmaf: 0 })),
			...Array.from({ length: 111 }, (_, i) => ({
				frameNum: 106 + i,
				vmaf: 30 + (i % 40),
			})),
		],
		frameCount: 217,
	} as unknown as VmafResultDetail;
}

/** A healthy ladder: low-ish but well-formed, which must NOT be flagged. */
function healthyResult(
	height: number,
	bitrate: number,
	mean: number,
): VmafResultDetail {
	return {
		id: `h-${height}`,
		renditionRef: { height, bitrate, codec: "H264" },
		pooled: {
			mean,
			min: mean - 8,
			max: mean + 6,
			harmonicMean: mean - 0.5,
			low1Percent: mean - 7,
			percentiles: { p1: mean - 7, p25: mean - 3, p50: mean },
			worstFrame: { frameNum: 1, vmaf: mean - 8 },
		},
		frames: Array.from({ length: 200 }, (_, i) => ({
			frameNum: i,
			vmaf: mean,
		})),
		frameCount: 200,
	} as unknown as VmafResultDetail;
}

/**
 * NO ENGLISH PROSE anywhere in the rendered output, checked over the WHOLE container.
 *
 * My first version asserted two specific English fragments were absent, on a fixture
 * that rendered neither the degenerate alert nor the ladder warning — so it checked
 * the one path that had no English left, and passed while the `role="alert"` line was
 * still an English sentence (review catch). `toHaveTextContent` did not help either:
 * it is a substring match, so a Japanese badge followed by an English sentence
 * satisfies it.
 *
 * The rule is `ja-render-sweep.ts`'s, applied in jsdom where it can be a gate: after
 * removing the technical tokens an operator expects to see untranslated, no run of
 * four or more Latin letters may remain.
 */
const TECHNICAL = [
	/vmaf_[\w.]+/gi,
	/\b(?:VMAF|PSNR|H264|H265|VP9|AV1|AAC|FMP4|CMAF|TS|MP4|WEBM|DASH|HLS|CENC|FAIRPLAY|DRM|SFTP|S3|GCS|UUID)\b/g,
	/\b\d+(?:\.\d+)?[kKmMgG]?(?:bps|p|%|×)?\b/g,
	/[·—→/,:()[\]]/g,
];

function expectNoEnglishProse(container: HTMLElement) {
	let text = container.textContent ?? "";
	for (const pattern of TECHNICAL) {
		text = text.replace(pattern, " ");
	}
	const words = text.match(/[A-Za-z][A-Za-z'-]{3,}/g) ?? [];
	expect(words, `English prose survived: ${words.join(" ")}`).toEqual([]);
}

describe("VmafContextBanner", () => {
	it("renders the comparison in JAPANESE — the point of ledger #35", () => {
		// The banner used to render two finished English sentences that
		// `vmaf-context.ts` built as DATA, so a Japanese operator read English here
		// whatever the catalogue said. A catalogue-parity check cannot see that: the
		// strings were never in the catalogue. This asserts the rendered output.
		const { container } = renderLocalized(
			<VmafContextBanner
				results={[healthyResult(360, 300_000, 42)]}
				model="vmaf_v1.0.16_3d0h"
				referenceHeight={1080}
			/>,
			"ja",
		);
		expect(
			screen.getByText(/360p → 1080p\(3\.0× アップスケール\)/),
		).toBeInTheDocument();
		expect(screen.getByText(/異なる解像度のVMAF比較/)).toBeInTheDocument();
		// The quiet part, in Japanese: a low cross-resolution score is not by itself
		// an encoder defect, and an operator who does not read that repeats the whole
		// investigation this module came from.
		expect(
			screen.getByText(/それだけでエンコーダの不具合とは判断できません/),
		).toBeInTheDocument();
		// The {model} JUNCTIONS, spanned: 。 is the separator and no ASCII space may
		// leak around the placeholder. Mutation-proven necessary — reverting ja.ts
		// to the spaced version passed all 149 qc+i18n tests, because every prior
		// assertion was a fragment that stopped short of the junction (review of
		// PR #152). One regex across sentence-end → model-part → next sentence.
		expect(
			screen.getByText(
				/比較しました。モデル vmaf_v1\.0\.16_3d0h。解像度やビットレートを低くした構成/,
			),
		).toBeInTheDocument();
		expectNoEnglishProse(container);
	});

	it("joins the sentences cleanly when NO model is recorded — ja", () => {
		/* When the optional model clause is absent, adjacent Japanese sentences must meet without an inserted space. */
		renderLocalized(
			<VmafContextBanner
				results={[healthyResult(360, 300_000, 42)]}
				referenceHeight={1080}
			/>,
			"ja",
		);
		expect(
			screen.getByText(/比較しました。解像度やビットレートを低くした構成/),
		).toBeInTheDocument();
	});

	it("renders a native comparison in Japanese with the comparison checks", () => {
		renderLocalized(
			<VmafContextBanner
				results={[healthyResult(1080, 4_000_000, 95)]}
				model="vmaf_v0.6.1"
				referenceHeight={1080}
			/>,
			"ja",
		);
		expect(screen.getByText(/1080p → 1080p\(等倍\)/)).toBeInTheDocument();
		expect(
			screen.getByText(/参照動画、フレームの同期、モデルを確認してください/),
		).toBeInTheDocument();
	});

	it("states the comparison's terms, upscale factor included", () => {
		renderLocalized(
			<VmafContextBanner
				results={[healthyResult(360, 300_000, 42)]}
				model="vmaf_v1.0.16_3d0h"
				referenceHeight={1080}
			/>,
		);
		expect(
			screen.getByText(/360p → 1080p \(3\.0× upscale\)/),
		).toBeInTheDocument();
		expect(
			screen.getByText(/not, on their own, an encoder defect/),
		).toBeInTheDocument();
		expect(screen.getByText(/vmaf_v1\.0\.16_3d0h/)).toBeInTheDocument();
	});

	it("renders the DEGENERATE alert in Japanese, whole container", () => {
		// THE case the previous version missed: the healthy fixture renders neither the
		// alert nor the ladder warning, so a "no English survives" claim checked on it
		// was checking the one path with nothing left to find. This is 's
		// actual report — 106 of 217 frames at zero — and its `role="alert"` line was
		// still an English sentence next to a translated badge.
		const { container } = renderLocalized(
			<VmafContextBanner
				results={[degenerateResult(360, 300_000)]}
				model="vmaf_v0.6.1"
				referenceHeight={1080}
			/>,
			"ja",
		);
		expect(screen.getByRole("alert").textContent).toMatch(
			/品質の測定値として成立していません|品質値として成立していません/,
		);
		expectNoEnglishProse(container);
	});

	it("renders the FLAT-LADDER warning in Japanese, whole container", () => {
		const { container } = renderLocalized(
			<VmafContextBanner
				results={[
					healthyResult(360, 300_000, 90),
					healthyResult(720, 900_000, 90),
				]}
				model="vmaf_v0.6.1"
				referenceHeight={1080}
			/>,
			"ja",
		);
		expectNoEnglishProse(container);
	});

	it("raises an alert for the real degenerate report", () => {
		renderLocalized(
			<VmafContextBanner
				results={[degenerateResult(360, 300_000)]}
				model="vmaf_v1.0.16_3d0h"
				referenceHeight={1080}
			/>,
		);
		const alert = screen.getByRole("alert");
		expect(alert).toHaveTextContent("Not a quality measurement");
		expect(alert).toHaveTextContent("106 of 217");
	});

	it("does NOT raise an alert for a low-but-sound ladder", () => {
		// The false alarm in reverse: flagging every aggressive ladder would make the
		// badge meaningless within a week.
		renderLocalized(
			<VmafContextBanner
				results={[healthyResult(360, 300_000, 22)]}
				model="vmaf_v0.6.1"
				referenceHeight={1080}
			/>,
		);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("asks operators to check the comparison before interpreting a native score", () => {
		renderLocalized(
			<VmafContextBanner
				results={[healthyResult(1080, 4_000_000, 60)]}
				model="vmaf_v0.6.1"
				referenceHeight={1080}
			/>,
		);
		expect(screen.getByText(/1080p → 1080p \(native\)/)).toBeInTheDocument();
		expect(
			screen.getByText(
				/Check the reference, frame alignment and model before drawing conclusions/,
			),
		).toBeInTheDocument();
	});

	it("admits it does not know when the source geometry was never recorded", () => {
		// Every report written before the worker started recording `params.reference`
		// lands here, and it must not invent an upscale factor.
		renderLocalized(
			<VmafContextBanner
				results={[healthyResult(360, 300_000, 42)]}
				model="vmaf_v0.6.1"
				referenceHeight={null}
			/>,
		);
		expect(screen.getByText(/Comparison terms unknown/)).toBeInTheDocument();
		expect(screen.getByText(/cannot be stated/)).toBeInTheDocument();
	});

	it("flags a ladder whose doubled bitrate changed nothing", () => {
		renderLocalized(
			<VmafContextBanner
				results={[
					healthyResult(360, 300_000, 42.0),
					healthyResult(540, 600_000, 42.2),
				]}
				model="vmaf_v0.6.1"
				referenceHeight={1080}
			/>,
		);
		expect(screen.getByText(/Ladder did not separate/)).toBeInTheDocument();
	});

	it("renders the Japanese badges under the ja locale", () => {
		renderLocalized(
			<VmafContextBanner
				results={[degenerateResult(360, 300_000)]}
				model="vmaf_v1.0.16_3d0h"
				referenceHeight={1080}
			/>,
			"ja",
		);
		expect(screen.getByRole("alert")).toHaveTextContent(
			"品質値として成立していません",
		);
	});

	it("renders nothing at all when there are no results", () => {
		const { container } = renderLocalized(
			<VmafContextBanner results={[]} model="m" referenceHeight={1080} />,
		);
		expect(container).toBeEmptyDOMElement();
	});
});
