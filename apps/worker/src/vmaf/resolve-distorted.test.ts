import { describe, expect, it, vi } from "vitest";
import type { ResolvedCredential } from "../orchestrator/executor";
import {
	buildKeyMatcher,
	type KeyLister,
	resolveDistortedKeys,
} from "./resolve-distorted";

const cred = {} as ResolvedCredential;
// The exact per-title template that 404'd in the field.
const TEMPLATE =
	"output/bbb-pte-crf-17/{height}_{bitrate}_{uuid}/qc/video1.mp4";

describe("buildKeyMatcher", () => {
	it("returns null for a path with no placeholder (download verbatim)", () => {
		expect(buildKeyMatcher("output/x/video/360p/qc/v360.mp4")).toBeNull();
	});

	it("derives the placeholder-free list prefix", () => {
		expect(buildKeyMatcher(TEMPLATE)?.prefix).toBe("output/bbb-pte-crf-17/");
	});

	it("matches a resolved key and rejects a foreign one", () => {
		const m = buildKeyMatcher(TEMPLATE);
		expect(
			m?.matches("output/bbb-pte-crf-17/360_500000_abc-123/qc/video1.mp4"),
		).toBe(true);
		// wrong rendition file
		expect(
			m?.matches("output/bbb-pte-crf-17/360_500000_abc-123/qc/video2.mp4"),
		).toBe(false);
		// extra path segment (placeholder is ONE segment, not many)
		expect(m?.matches("output/bbb-pte-crf-17/360/500000/qc/video1.mp4")).toBe(
			false,
		);
		// not under the qc/ child
		expect(
			m?.matches("output/bbb-pte-crf-17/360_500000_abc/fmp4/video1.mp4"),
		).toBe(false);
	});

	it("extracts the resolved placeholder segment as the variant", () => {
		expect(
			buildKeyMatcher(TEMPLATE)?.variant(
				"output/bbb-pte-crf-17/720_1500000_def-456/qc/video1.mp4",
			),
		).toBe("720_1500000_def-456");
	});

	it("treats regex-special literals in the path as literal", () => {
		const m = buildKeyMatcher("a.b/{x}/c.mp4");
		expect(m?.matches("a.b/v/c.mp4")).toBe(true);
		expect(m?.matches("aXb/v/c.mp4")).toBe(false); // the '.' is literal, not any-char
	});
});

describe("resolveDistortedKeys", () => {
	it("returns the path itself when not templated (no listing)", async () => {
		const lister = vi.fn();
		const out = await resolveDistortedKeys(
			lister as unknown as KeyLister,
			cred,
			"bucket",
			"output/x/video/360p/qc/v360.mp4",
		);
		expect(out).toEqual([{ key: "output/x/video/360p/qc/v360.mp4" }]);
		expect(lister).not.toHaveBeenCalled();
	});

	it("lists + matches every per-title rung, sorted, with variants", async () => {
		const lister: KeyLister = async ({ prefix }) => {
			expect(prefix).toBe("output/bbb-pte-crf-17/");
			return [
				// two real rungs + noise that must NOT match
				{ key: "output/bbb-pte-crf-17/720_1500000_def/qc/video1.mp4" },
				{ key: "output/bbb-pte-crf-17/360_500000_abc/qc/video1.mp4" },
				{ key: "output/bbb-pte-crf-17/360_500000_abc/fmp4/seg_0.m4s" },
				{ key: "output/bbb-pte-crf-17/360_500000_abc/qc/video2.mp4" },
			];
		};
		const out = await resolveDistortedKeys(lister, cred, "bucket", TEMPLATE);
		expect(out).toEqual([
			{
				key: "output/bbb-pte-crf-17/360_500000_abc/qc/video1.mp4",
				variant: "360_500000_abc",
			},
			{
				key: "output/bbb-pte-crf-17/720_1500000_def/qc/video1.mp4",
				variant: "720_1500000_def",
			},
		]);
	});

	it("throws a clear error when nothing matches (mirror not written)", async () => {
		const lister: KeyLister = async () => [
			{ key: "output/bbb-pte-crf-17/360_500000_abc/fmp4/seg_0.m4s" },
		];
		await expect(
			resolveDistortedKeys(lister, cred, "bucket", TEMPLATE),
		).rejects.toThrow(/no object under "output\/bbb-pte-crf-17\/" matched/);
	});

	describe("modifiedSince scope (over-counting fix)", () => {
		const ENCODE_START = "2026-06-20T12:00:00.000Z";
		// Two rungs THIS run wrote (at/after start) + two a PRIOR run left under the
		// same base (earlier). Only this run's must come back.
		const lister: KeyLister = async () => [
			{
				key: "output/bbb-pte-crf-17/360_500000_thisrun/qc/video1.mp4",
				lastModified: "2026-06-20T12:00:05.000Z",
			},
			{
				key: "output/bbb-pte-crf-17/720_1500000_thisrun/qc/video1.mp4",
				lastModified: "2026-06-20T12:00:06.000Z",
			},
			{
				key: "output/bbb-pte-crf-17/360_500000_oldrun/qc/video1.mp4",
				lastModified: "2026-06-01T00:00:00.000Z",
			},
			{
				key: "output/bbb-pte-crf-17/720_1500000_oldrun/qc/video1.mp4",
				lastModified: "2026-06-19T23:59:59.000Z",
			},
		];

		it("excludes a stale prior-run mirror but keeps the current run's", async () => {
			const out = await resolveDistortedKeys(
				lister,
				cred,
				"bucket",
				TEMPLATE,
				ENCODE_START,
			);
			expect(out.map((d) => d.variant)).toEqual([
				"360_500000_thisrun",
				"720_1500000_thisrun",
			]);
		});

		it("keeps an object whose lastModified is unknown (can't prove stale)", async () => {
			const mixed: KeyLister = async () => [
				{
					key: "output/bbb-pte-crf-17/360_500000_known/qc/video1.mp4",
					lastModified: "2026-06-20T12:00:05.000Z",
				},
				// No lastModified → kept (fail toward scoring, not silent drop).
				{ key: "output/bbb-pte-crf-17/540_900000_unknown/qc/video1.mp4" },
			];
			const out = await resolveDistortedKeys(
				mixed,
				cred,
				"bucket",
				TEMPLATE,
				ENCODE_START,
			);
			expect(out.map((d) => d.variant).sort()).toEqual([
				"360_500000_known",
				"540_900000_unknown",
			]);
		});

		it("throws (naming the cutoff) when every match predates the window", async () => {
			const allOld: KeyLister = async () => [
				{
					key: "output/bbb-pte-crf-17/360_500000_oldrun/qc/video1.mp4",
					lastModified: "2026-06-01T00:00:00.000Z",
				},
			];
			await expect(
				resolveDistortedKeys(allOld, cred, "bucket", TEMPLATE, ENCODE_START),
			).rejects.toThrow(/written at\/after 2026-06-20T12:00:00\.000Z/);
		});
	});
});
