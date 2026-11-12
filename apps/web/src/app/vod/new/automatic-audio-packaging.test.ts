import { encodingPlanSchema, validatePlan } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	draftKey,
	readWizardDraft,
	writeWizardDraft,
} from "@/lib/wizard-draft";
import {
	followRenamedAudioKeys,
	reconcileAutomaticAudioPackaging,
} from "./automatic-audio-packaging";
import {
	audioKeys,
	buildPlan,
	DEFAULT_WIZARD_STATE,
	type WizardState,
} from "./build-plan";
import { addVodAudio, addVodVideo } from "./rendition-copy";

const initial = (): WizardState => ({
	...DEFAULT_WIZARD_STATE,
	videos: [
		{
			height: 360,
			bitrate: 800000,
			muxing: { kind: "TS", muxedAudioKeys: ["a128"] },
		},
	],
	audios: [{ bitrate: 128000, rate: 48000 }],
});

describe("automatic audio packaging across wizard steps", () => {
	it("restores automatic audio output when a new default fMP4 rendition is added", () => {
		const state = initial();
		state.audios = reconcileAutomaticAudioPackaging(state);
		expect(state.audios[0]?.muxing).toMatchObject({
			ownContainer: false,
			autoOwnContainer: true,
		});
		state.videos.push({ height: 720, bitrate: 1500000 });
		state.audios = reconcileAutomaticAudioPackaging(state);
		expect(state.audios[0]?.muxing?.ownContainer).toBeUndefined();
		expect(
			buildPlan(state).muxings.some((muxing) => muxing.streamKey === "a128"),
		).toBe(true);
	});
	it("preserves imported or manually disabled audio output without automatic provenance", () => {
		const state = initial();
		state.audios = state.audios.map((audio) => ({
			...audio,
			muxing: { ownContainer: false },
		}));
		state.videos.push({ height: 720, bitrate: 1500000 });
		expect(reconcileAutomaticAudioPackaging(state)[0]?.muxing).toEqual({
			ownContainer: false,
		});
	});
	it.each([
		{ kind: "TS" as const },
		{ path: "custom/audio" },
		{ filename: "sound.mp4" },
	])("preserves explicit primary audio configuration %j", (muxing) => {
		const state = initial();
		state.audios = state.audios.map((audio) => ({ ...audio, muxing }));
		expect(reconcileAutomaticAudioPackaging(state)[0]?.muxing).toEqual(muxing);
	});
	it("restores automatic output when its primary settings are customized later", () => {
		const state = initial();
		state.audios = reconcileAutomaticAudioPackaging(state);
		state.audios = state.audios.map((audio) => ({
			...audio,
			muxing: { ...audio.muxing, path: "custom/audio" },
		}));
		expect(reconcileAutomaticAudioPackaging(state)[0]?.muxing).toEqual({
			path: "custom/audio",
			ownContainer: undefined,
			autoOwnContainer: undefined,
		});
	});
	it("never emits wizard provenance into the encoding plan", () => {
		const state = initial();
		state.audios = reconcileAutomaticAudioPackaging(state);
		expect(JSON.stringify(buildPlan(state))).not.toContain("autoOwnContainer");
	});
});

describe("audio keys carried by a video container", () => {
	const low = { bitrate: 128000, rate: 48000 };
	const high = { bitrate: 192000, rate: 48000 };
	const carrying = (...keys: string[]): WizardState["videos"] => [
		{
			height: 360,
			bitrate: 800000,
			muxing: { kind: "TS", muxedAudioKeys: keys },
			extraMuxings: [{ kind: "MP4", muxedAudioKeys: keys }],
		},
	];
	type Rows = Pick<WizardState, "videos" | "audios">;
	const carried = (state: Rows) =>
		state.videos.map((video) => [
			video.muxing?.muxedAudioKeys,
			video.extraMuxings?.map((leg) => leg.muxedAudioKeys),
		]);
	const waiting = (state: Rows) => state.audios.map((audio) => audio.carriedAs);
	/** One row edited, as the wizard's `patch` applies it. */
	const edit = (
		state: Rows,
		row: number,
		change: Partial<WizardState["audios"][number]>,
	): Rows => {
		const next = {
			...state,
			audios: state.audios.map((audio, index) =>
				index === row ? { ...audio, ...change } : audio,
			),
		};
		return { ...next, ...followRenamedAudioKeys(state, next) };
	};
	/** A bitrate as the field hands it over, one keystroke after the other. */
	const type = (state: Rows, row: number, digits: string) =>
		[...digits].reduce(
			(typed, _digit, at) =>
				edit(typed, row, { bitrate: Number(digits.slice(0, at + 1)) }),
			edit(state, row, { bitrate: 0 }),
		);

	it("follow a bitrate edit, so the track stays inside the container", () => {
		const before = { videos: carrying("a128"), audios: [low] };
		const after = { ...before, audios: [high] };
		const state: WizardState = {
			...DEFAULT_WIZARD_STATE,
			...followRenamedAudioKeys(before, after),
		};
		state.audios = reconcileAutomaticAudioPackaging(state);
		// Both containers of the rendition carry the track; none is made for it alone.
		expect(
			buildPlan(state).muxings.map((muxing) => [
				muxing.kind,
				muxing.streamKey,
				"additionalStreamKeys" in muxing
					? muxing.additionalStreamKeys
					: undefined,
			]),
		).toEqual([
			["TS", "v360", ["a192"]],
			["MP4", "v360", ["a192"]],
		]);
	});

	it("rename only the track that changed", () => {
		const before = { videos: carrying("a128", "a192"), audios: [low, high] };
		const after = {
			...before,
			audios: [low, { bitrate: 256000, rate: 48000 }],
		};
		expect(carried(followRenamedAudioKeys(before, after))).toEqual([
			[["a128", "a256"], [["a128", "a256"]]],
		]);
	});

	it("keep the track a container carries while another bitrate is typed through its value", () => {
		// 640 kbps typed into the second row is "64000" for one keystroke: for that
		// moment both rows derive one key, and it names neither of them.
		const small = { bitrate: 64000, rate: 48000 };
		const typed = type(
			{ videos: carrying("a64"), audios: [small, high] },
			1,
			"640000",
		);
		expect(audioKeys(typed.audios)).toEqual(["a64", "a640"]);
		expect(carried(typed)).toEqual([[["a64"], [["a64"]]]]);
		expect(waiting(typed)).toEqual([undefined, undefined]);
	});

	it.each([
		["the second row", [64000, 128000], 1, "640000", "a640"],
		["the first row", [128000, 64000], 0, "640000", "a640"],
		["320 past a row of 32", [32000, 128000], 1, "320000", "a320"],
	] satisfies [
		string,
		number[],
		number,
		string,
		string,
	][])("keep the track of the row that is typed through another row's value: %s", (_case, bitrates, row, digits, key) => {
		// The row a file carries is the one being typed into: left at the key it
		// had before the two met, the file would end without its audio.
		const state: WizardState = {
			...DEFAULT_WIZARD_STATE,
			videos: [
				{
					height: 1080,
					bitrate: 8_000_000,
					muxing: { kind: "MP4", muxedAudioKeys: ["a128"] },
				},
			],
			audios: bitrates.map((bitrate) => ({ bitrate, rate: 48000 })),
		};
		const typed = type(state, row, digits);
		expect(carried(typed)).toEqual([[[key], undefined]]);
		expect(waiting(typed)).toEqual([undefined, undefined]);
		const settled: WizardState = { ...state, ...typed };
		settled.audios = reconcileAutomaticAudioPackaging(settled);
		expect(
			buildPlan(settled).muxings.map((muxing) => [
				muxing.kind,
				muxing.streamKey,
				...("additionalStreamKeys" in muxing
					? (muxing.additionalStreamKeys ?? [])
					: []),
			]),
		).toEqual(
			// The other track has its own container, as it had; the typed one has none.
			[
				["MP4", "v1080", key],
				["FMP4", `a${(bitrates[row === 0 ? 1 : 0] ?? 0) / 1000}`],
			],
		);
	});

	describe("while two rows have one key", () => {
		const small = { bitrate: 64000, rate: 48000 };
		// Two files, each with one of the tracks inside.
		const two: Rows = {
			videos: [
				{
					height: 1080,
					bitrate: 8_000_000,
					muxing: {
						kind: "MP4",
						filename: "full.mp4",
						muxedAudioKeys: ["a64"],
					},
				},
				{
					height: 720,
					bitrate: 4_000_000,
					muxing: {
						kind: "MP4",
						filename: "proxy.mp4",
						muxedAudioKeys: ["a128"],
					},
				},
			],
			audios: [small, low],
		};
		const equal = edit(two, 1, { bitrate: 64000 });

		it("the containers keep their names, and each row remembers its own", () => {
			expect(audioKeys(equal.audios)).toEqual(["a64_48000", "a64_48000"]);
			expect(carried(equal)).toEqual([
				[["a64"], undefined],
				[["a128"], undefined],
			]);
			expect(waiting(equal)).toEqual(["a64", "a128"]);
		});

		it("the plan names a key twice and is refused, so no file starts without its track", () => {
			const state: WizardState = {
				...DEFAULT_WIZARD_STATE,
				name: "two tracks",
				inputFiles: [
					{
						key: "main",
						inputKey: "main",
						kind: "S3",
						credentialId: "00000000-0000-4000-8000-000000000001",
						bucket: "in",
						path: "source.mov",
						name: "S3 Input",
					},
				],
				output: {
					...DEFAULT_WIZARD_STATE.output,
					credentialId: "00000000-0000-4000-8000-000000000002",
					bucket: "out",
					basePath: "job/",
				},
				manifests: { hls: false, dash: false },
				...equal,
			};
			state.audios = reconcileAutomaticAudioPackaging(state);
			const issues = validatePlan(encodingPlanSchema.parse(buildPlan(state)));
			expect(
				issues.filter((issue) => issue.code === "PLAN_DUPLICATE_KEY").length,
			).toBeGreaterThan(0);
			// What the form remembers is not in the plan.
			expect(JSON.stringify(buildPlan(state))).not.toContain("carriedAs");
		});

		it("the row that changes next takes its file with it, whichever row that is", () => {
			// The same row again, or the one it was made equal to.
			for (const row of [0, 1]) {
				const apart = edit(equal, row, { bitrate: 96000 });
				expect(audioKeys(apart.audios), `row ${row}`).toEqual(
					row === 0 ? ["a96", "a64"] : ["a64", "a96"],
				);
				expect(carried(apart), `row ${row}`).toEqual(
					row === 0
						? [
								[["a96"], undefined],
								[["a64"], undefined],
							]
						: [
								[["a64"], undefined],
								[["a96"], undefined],
							],
				);
				expect(waiting(apart), `row ${row}`).toEqual([undefined, undefined]);
			}
		});

		it("a key typed for one of them sets both free", () => {
			const keyed = edit(equal, 1, { extras: { key: "second" } });
			expect(carried(keyed)).toEqual([
				[["a64"], undefined],
				[["second"], undefined],
			]);
			expect(waiting(keyed)).toEqual([undefined, undefined]);
		});

		it("removing one of them sets the other free", () => {
			for (const kept of [0, 1]) {
				const next = {
					...equal,
					audios: [equal.audios[kept]] as Rows["audios"],
				};
				const alone = { ...next, ...followRenamedAudioKeys(equal, next) };
				expect(audioKeys(alone.audios)).toEqual(["a64"]);
				expect(waiting(alone)).toEqual([undefined]);
				// The file of the row that stayed carries it under its key again.
				expect(carried(alone)[kept]).toEqual([["a64"], undefined]);
			}
		});

		it("a row added beside them changes nothing, and a copy of one does not wait", () => {
			const copied = addVodAudio(
				{ ...DEFAULT_WIZARD_STATE, ...equal } as WizardState,
				1,
			);
			expect(copied.audios.map((audio) => audio.carriedAs)).toEqual([
				"a64",
				"a128",
				undefined,
			]);
			const next = { ...equal, ...copied };
			expect(
				waiting({ ...next, ...followRenamedAudioKeys(equal, next) }),
			).toEqual(["a64", "a128", undefined]);
		});

		it("a row added then is not given a name that a row's files wait under", () => {
			// 640 on the way to 6400 is the key `a1`, which is also what the first
			// blank row added to a ladder is given.
			const start: Rows = {
				videos: ["a32", "a6"].map((key, index) => ({
					height: index === 0 ? 1080 : 720,
					bitrate: 8_000_000,
					muxing: {
						kind: "MP4" as const,
						filename: `${key}.mp4`,
						muxedAudioKeys: [key],
					},
				})),
				audios: [
					{ bitrate: 32000, rate: 48000 },
					{ bitrate: 6400, rate: 48000 },
				],
			};
			const held = type(start, 0, "6400");
			expect(waiting(held)).toEqual(["a1", "a6"]);
			const added = addVodAudio({
				...DEFAULT_WIZARD_STATE,
				...held,
			} as WizardState);
			expect(added.audios.map((audio) => audio.extras?.key)).toEqual([
				"a6_48000",
				"a6_48000",
				"a2",
			]);
			const grown = { ...held, ...added };
			const three: Rows = { ...grown, ...followRenamedAudioKeys(held, grown) };
			// With the second row gone the first has its key to itself, and its
			// file goes on carrying it: not the row that was added.
			const fewer = {
				...three,
				audios: three.audios.filter((_audio, index) => index !== 1),
			};
			const left: Rows = { ...fewer, ...followRenamedAudioKeys(three, fewer) };
			expect(waiting(left)).toEqual([undefined, undefined]);
			expect(carried(left)[0]).toEqual([["a6_48000"], undefined]);
		});

		it("stays as it is in a saved draft", () => {
			const key = draftKey(["org", "user"], "vod", "new");
			writeWizardDraft(
				key,
				"vod",
				{ ...DEFAULT_WIZARD_STATE, ...equal } as WizardState,
				2,
			);
			const restored = readWizardDraft(key, "vod")
				?.value as Partial<WizardState>;
			expect(restored.audios?.map((audio) => audio.carriedAs)).toEqual([
				"a64",
				"a128",
			]);
			localStorage.removeItem(key);
		});
	});

	it("leave a row's containers alone when its key is unchanged and another row comes to share it", () => {
		// Three rows; two already tell their keys apart by the sample rate.
		const state: Rows = {
			videos: [
				{
					height: 1080,
					bitrate: 8_000_000,
					muxing: { kind: "MP4", muxedAudioKeys: ["a64_48000"] },
				},
				{
					height: 720,
					bitrate: 4_000_000,
					muxing: { kind: "MP4", muxedAudioKeys: ["a128"] },
				},
			],
			audios: [
				{ bitrate: 64000, rate: 48000 },
				{ bitrate: 64000, rate: 44100 },
				low,
			],
		};
		const equal = edit(state, 2, { bitrate: 64000 });
		expect(audioKeys(equal.audios)).toEqual([
			"a64_48000",
			"a64_44100",
			"a64_48000",
		]);
		expect(waiting(equal)).toEqual([undefined, undefined, "a128"]);
		const apart = edit(equal, 2, { bitrate: 640000 });
		expect(carried(apart)).toEqual([
			[["a64_48000"], undefined],
			[["a640"], undefined],
		]);
		expect(waiting(apart)).toEqual([undefined, undefined, undefined]);
	});

	it("leave a key two rows were already known by where it is, whichever row is edited", () => {
		const twin = { bitrate: 128000, rate: 48000 };
		const before = {
			videos: carrying("a128_48000"),
			audios: [low, twin],
		};
		const after = { ...before, audios: [low, high] };
		expect(followRenamedAudioKeys(before, after)).toBe(after);
	});

	it.each([
		[
			"a typed key, which the edit does not change",
			[{ ...low, extras: { key: "main" } }],
			[{ ...high, extras: { key: "main" } }],
		],
		["a removed track", [low, high], [high]],
		["an added track", [low], [low, high]],
		// The same keys in another order: which track a key means has not changed.
		["tracks that change places", [low, high], [high, low]],
	] satisfies [
		string,
		WizardState["audios"],
		WizardState["audios"],
	][])("leave the containers as they are for %s", (_case, from, to) => {
		const before = { videos: carrying("a128"), audios: from };
		const after = { ...before, audios: to };
		expect(followRenamedAudioKeys(before, after)).toBe(after);
	});

	describe("a track that every file carries, while it waits for its key", () => {
		/** An edit as the wizard applies it: the names follow, then the packaging. */
		const apply = (
			state: WizardState,
			change: Partial<WizardState>,
		): WizardState => {
			const next = { ...state, ...change };
			Object.assign(next, followRenamedAudioKeys(state, next));
			next.audios = reconcileAutomaticAudioPackaging(next);
			return next;
		};
		const bitrate = (state: WizardState, row: number, value: number) =>
			apply(state, {
				audios: state.audios.map((audio, index) =>
					index === row ? { ...audio, bitrate: value } : audio,
				),
			});
		const without = (state: WizardState, row: number) =>
			apply(state, {
				audios: state.audios.filter((_audio, index) => index !== row),
			});
		const outputs = (state: WizardState) =>
			buildPlan(state).muxings.map((muxing) => [
				muxing.kind,
				muxing.streamKey,
				...((muxing as { additionalStreamKeys?: string[] })
					.additionalStreamKeys ?? []),
			]);
		const file = (name: string, audio: string[]): WizardState["videos"][0] => ({
			height: name === "full" ? 1080 : 720,
			bitrate: 8_000_000,
			muxing: { kind: "MP4", filename: `${name}.mp4`, muxedAudioKeys: audio },
		});
		const tracks = [
			{ bitrate: 64000, rate: 48000 },
			{ bitrate: 128000, rate: 48000 },
		];
		// One file with the first track inside; the second track is on its own.
		const start = apply(
			{
				...DEFAULT_WIZARD_STATE,
				videos: [file("full", ["a64"])],
				audios: tracks,
			},
			{},
		);
		const held = bitrate(start, 1, 64000);
		const inside = { ownContainer: false, autoOwnContainer: true };

		it("has no container of its own before, meanwhile and after", () => {
			expect(start.audios[0]?.muxing).toEqual(inside);
			expect(waiting(held)).toEqual(["a64", "a128"]);
			expect(held.audios[0]?.muxing).toEqual(inside);
			const parted = bitrate(held, 1, 640000);
			expect(parted.audios[0]?.muxing).toEqual(inside);
			expect(outputs(parted)).toEqual([
				["MP4", "v1080", "a64"],
				["FMP4", "a640"],
			]);
		});

		it("is not given one by a row added meanwhile", () => {
			const added = apply(held, addVodAudio(held));
			expect(added.audios.map((audio) => audio.muxing)).toEqual([
				inside,
				{ path: "audio/64_48000" },
				{ key: "a1", path: "audio/a1" },
			]);
			expect(outputs(without(added, 1))).toEqual([
				["MP4", "v1080", "a64_48000"],
				["FMP4", "a1"],
			]);
		});

		it("nor by a copy of its file made meanwhile", () => {
			const copied = apply(held, addVodVideo(held, 0));
			expect(copied.audios.map((audio) => audio.muxing)).toEqual([
				inside,
				{ path: "audio/64_48000" },
			]);
			expect(outputs(without(copied, 1))).toEqual([
				["MP4", "v1080", "a64_48000"],
				["MP4", "v1080-2", "a64_48000"],
			]);
		});

		it("keeps a container of its own, and the folder it has, when one file leaves it out", () => {
			const partly = apply(
				{
					...DEFAULT_WIZARD_STATE,
					videos: [file("full", ["a64"]), file("proxy", [])],
					audios: tracks,
				},
				{},
			);
			expect(partly.audios[0]?.muxing).toBeUndefined();
			const meanwhile = bitrate(partly, 1, 64000);
			expect(waiting(meanwhile)).toEqual(["a64", "a128"]);
			const added = apply(meanwhile, addVodAudio(meanwhile));
			expect(added.audios[0]?.muxing).toEqual({ path: "audio/64_48000" });
			expect(outputs(without(added, 1))).toEqual([
				["MP4", "v1080", "a64_48000"],
				["MP4", "v720"],
				["FMP4", "a64_48000"],
				["FMP4", "a1"],
			]);
		});

		it.each([
			["no file", []],
			["only a container that cannot hold audio", ["a64"]],
		])("pins the container that is built anyway when %s carries the track", (_what, named) => {
			// Switched off by hand, and built all the same: nothing carries it.
			const lone = apply(
				{
					...DEFAULT_WIZARD_STATE,
					videos: [
						{
							height: 1080,
							bitrate: 8_000_000,
							muxing: { kind: "FMP4", muxedAudioKeys: named },
						},
					],
					audios: [
						{ ...tracks[0], muxing: { ownContainer: false } },
						tracks[1],
					],
				} as WizardState,
				{},
			);
			const meanwhile = bitrate(lone, 1, 64000);
			expect(waiting(meanwhile)).toEqual(["a64", "a128"]);
			const added = apply(meanwhile, addVodAudio(meanwhile));
			expect(added.audios[0]?.muxing).toEqual({
				ownContainer: false,
				path: "audio/64_48000",
			});
		});
	});

	it("keep every file with the row it carried, through any run of edits", () => {
		// What a file carries is checked against the row it started with, each
		// time no two rows have one key. Values are few, so rows often meet.
		// mulberry32, on `Math.imul`. A 31-bit multiplier on a plain number
		// passes 2^53 and loses the low bits, which is where a small modulus looks.
		let seed = 20261112;
		const pick = <T>(from: readonly T[]): T => {
			seed = (seed + 0x6d2b79f5) | 0;
			let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
			const unit = ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
			return from[Math.floor(unit * from.length)] as T;
		};
		const bitrates = [6400, 32000, 64000, 128000, 320000, 640000];
		const rates = [44100, 48000];
		// A typed key can be another row's, or the key another row would derive.
		const typed = ["main", "a64", "a128"];
		let met = 0;
		for (let run = 0; run < 200; run++) {
			const rows = pick([2, 3, 4]);
			const audios = Array.from({ length: rows }, (_row, index) => ({
				bitrate: 8000 * (index + 1),
				rate: 48000,
			}));
			const keys = audioKeys(audios);
			let state: Rows = {
				audios,
				// One file per row, and one that carries the first two.
				videos: [
					...keys.map((key) => ({
						height: 1080,
						bitrate: 8_000_000,
						muxing: { kind: "MP4" as const, muxedAudioKeys: [key] },
					})),
					{
						height: 720,
						bitrate: 4_000_000,
						muxing: { kind: "TS" as const, muxedAudioKeys: keys.slice(0, 2) },
					},
				],
			};
			for (let step = 0; step < 12; step++) {
				const row = pick(Array.from({ length: rows }, (_row, index) => index));
				state = edit(
					state,
					row,
					pick([
						{ bitrate: pick(bitrates) },
						{ bitrate: pick(bitrates) },
						{ rate: pick(rates) },
						{ bitrate: pick(bitrates), rate: pick(rates) },
						{ extras: { key: pick(typed) } },
						{ extras: undefined },
					]),
				);
				const now = audioKeys(state.audios);
				const at = `run ${run}, step ${step}: ${JSON.stringify(state.audios)}`;
				// A row's files name its key, or the name it remembers for them, and
				// no two rows are known by one name.
				const names = state.audios.map(
					(audio, index) => audio.carriedAs ?? now[index],
				);
				expect(new Set(names).size, at).toBe(names.length);
				expect(
					state.videos.map((video) => video.muxing?.muxedAudioKeys),
					at,
				).toEqual([...names.map((name) => [name]), names.slice(0, 2)]);
				// A row waits only while the plan is refused for a key it names twice.
				if (new Set(now).size === now.length) expect(names, at).toEqual(now);
				else met++;
			}
		}
		// The run is about rows that meet: it has to have seen many.
		expect(met).toBeGreaterThan(400);
	});
});
