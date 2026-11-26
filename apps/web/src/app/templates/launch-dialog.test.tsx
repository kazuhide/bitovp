import { createHash } from "node:crypto";
import {
	type EncodingPlan,
	encodingPlanSchema,
	instantiateTemplatePlan,
	templateSourceSites,
} from "@bitovp/core";
import { samplePresetPlan } from "@bitovp/core/presets";
import { onlineManager } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSubmissionClient } from "@/lib/creation-submission";
import { canonicalCreateRequestJson } from "@/lib/creation-submission-contract";
import { renderWithOperatorSession as renderWithQuery } from "@/test/render";
import { LaunchDialog } from "./launch-dialog";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async () => {
	const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
	return {
		ApiError: actual.ApiError,
		apiFetch: (...args: unknown[]) => apiFetch(...args),
	};
});

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: routerPush }),
}));

afterEach(() => {
	onlineManager.setOnline(true);
	apiFetch.mockReset();
	routerPush.mockReset();
	vi.useRealTimers();
});

const ID = "11111111-2222-4333-8444-555555555555";
beforeEach(() => sessionStorage.clear());
vi.mock("@/lib/auth/use-session", async (original) => ({
	...(await original<Record<string, unknown>>()),
	useSession: () => ({
		status: "success",
		isFetchedAfterMount: true,
		isFetching: false,
		data: {
			configured: true,
			authenticated: true,
			mode: "users",
			role: "OPERATOR",
			organizationId: "org",
			effectiveUserId: "user",
		},
	}),
}));

function detailFor(body: unknown) {
	return {
		id: ID,
		name: "hardened-hls",
		body,
		launchDefaults: null,
		revision: 3,
	};
}

describe("LaunchDialog (ledger #109 §4.1)", () => {
	it.each([
		"hdrpicture",
		"__proto__",
		"constructor",
	])("requires matching JSON after each change of HDR source %s", async (streamKey) => {
		const base = encodingPlanSchema.parse(
			samplePresetPlan("fixed-bitrate-hls-on-aws"),
		);
		const input = base.inputs[0],
			output = base.outputs[0];
		if (!input || !output) throw new Error("Missing sample storage");
		const body = {
			planVersion: 1,
			name: "HDR10+ template",
			bitmovin: { encoderVersion: "2.294.0" },
			inputs: base.inputs,
			outputs: base.outputs,
			ingest: [],
			hdr10PlusStreams: [
				{
					key: streamKey,
					inputKey: input.key,
					videoInputPath: "cut1.mp4",
					metadataInputPath: "cut1.json",
				},
			],
			renditions: [
				{
					key: "hevc",
					codec: "H265",
					ingestKey: streamKey,
					height: 1080,
					bitrate: 4000000,
				},
			],
			muxings: [
				{
					key: "mux",
					kind: "FMP4",
					streamKey: "hevc",
					destination: { outputKey: output.key, path: "video" },
				},
			],
			manifests: [],
			generation: { timing: "JUST_IN_TIME" },
		};
		apiFetch.mockImplementation(async (url: string, init?: RequestInit) =>
			url === `/api/presets/${ID}`
				? detailFor(body)
				: init?.method === "POST"
					? { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee6" }
					: [],
		);
		renderWithQuery(<LaunchDialog presetId={ID} onClose={() => {}} />);
		const picture = await screen.findByLabelText(streamKey);
		const metadata = screen.getByLabelText(`${streamKey}:metadata`);
		const launch = screen.getByRole("button", { name: /Create job/i });
		await waitFor(() => expect(launch).toBeEnabled());
		const change = (field: HTMLElement, value: string) =>
			fireEvent.change(field, { target: { value } });
		change(picture, "cut2.mp4");
		fireEvent.click(launch);
		await screen.findAllByText(/select both the replacement HDR10\+ picture/i);
		expect(
			apiFetch.mock.calls.some(([url]) => url === "/api/encoding-jobs"),
		).toBe(false);
		change(metadata, "cut2.json");
		change(picture, "cut3.mp4");
		fireEvent.click(launch);
		await waitFor(() => expect(launch).toBeEnabled());
		expect(
			apiFetch.mock.calls.some(([url]) => url === "/api/encoding-jobs"),
		).toBe(false);
		change(metadata, "cut3.json");
		fireEvent.click(launch);
		await waitFor(() =>
			expect(routerPush).toHaveBeenCalledWith(
				"/vod/jobs/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee6",
			),
		);
		const post = apiFetch.mock.calls.find(
			([url]) => url === "/api/encoding-jobs",
		);
		if (!post) throw new Error("Missing accepted create");
		expect(JSON.parse(post[1].body).plan.hdr10PlusStreams[0]).toMatchObject({
			videoInputPath: "cut3.mp4",
			metadataInputPath: "cut3.json",
		});
	});
	it("keeps unstructured provider diagnostics out of the creation error", async () => {
		apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
			if (url === `/api/presets/${ID}`)
				return detailFor(samplePresetPlan("fixed-bitrate-hls-on-aws"));
			if (init?.method === "POST")
				throw new Error("PRIVATE_PROVIDER_DIAGNOSTIC");
			return [];
		});
		renderWithQuery(<LaunchDialog presetId={ID} onClose={() => {}} />);
		await screen.findByLabelText(/Job name/i);
		const submit = screen.getByRole("button", { name: /Create job/i });
		fireEvent.click(submit);
		await waitFor(() =>
			expect(
				apiFetch.mock.calls.some(([, init]) => init?.method === "POST"),
			).toBe(true),
		);
		await waitFor(() => expect(submit).toBeEnabled());
		expect(screen.queryByText(/PRIVATE_PROVIDER_DIAGNOSTIC/)).toBeNull();
		expect(screen.getByText("Create failed")).toBeInTheDocument();
	});
	it.each([
		"sparse source",
		"UUID name",
		"midnight",
	])("retains visible values and creation identity after remount with %s", async (mode) => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2030-01-01T23:59:59Z"));
		const body = samplePresetPlan("fixed-bitrate-hls-on-aws");
		apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
			if (url === `/api/presets/${ID}`)
				return {
					...detailFor(body),
					launchDefaults:
						mode === "UUID name"
							? { nameTemplate: "{template} {date} {uuid}" }
							: null,
				};
			if (url === "/api/encoding-jobs" && init?.method === "POST")
				throw new Error("response lost");
			return [];
		});
		const view = renderWithQuery(
			<LaunchDialog presetId={ID} onClose={() => {}} />,
		);
		const firstName = (await screen.findByLabelText(
			/Job name/i,
		)) as HTMLInputElement;
		await waitFor(() => expect(firstName.value).not.toBe(""));
		const visibleName = firstName.value;
		if (mode === "sparse source") {
			const site = templateSourceSites(encodingPlanSchema.parse(body))[0];
			if (!site) throw new Error("missing source");
			const field = screen.getByLabelText(site.siteId);
			fireEvent.change(field, { target: { value: "temporary.mp4" } });
			fireEvent.change(field, { target: { value: site.currentPath } });
		}
		fireEvent.click(screen.getByRole("button", { name: /Create job/i }));
		await screen.findByText("Create failed");
		view.unmount();
		if (mode === "midnight") vi.setSystemTime(new Date("2030-01-02T00:00:01Z"));
		renderWithQuery(<LaunchDialog presetId={ID} onClose={() => {}} />);
		const restoredName = await screen.findByLabelText(/Job name/i);
		await waitFor(() => expect(restoredName).toHaveValue(visibleName));
		fireEvent.click(screen.getByRole("button", { name: /Create job/i }));
		await waitFor(() =>
			expect(
				apiFetch.mock.calls.filter(([url]) => url === "/api/encoding-jobs"),
			).toHaveLength(2),
		);
		const posts = apiFetch.mock.calls.filter(
			([url]) => url === "/api/encoding-jobs",
		);
		expect(new Headers(posts[1]?.[1].headers).get("Idempotency-Key")).toBe(
			new Headers(posts[0]?.[1].headers).get("Idempotency-Key"),
		);
		expect(posts[1]?.[1].body).toBe(posts[0]?.[1].body);
	});
	it("retries a lost response with the same creation key and rendered output prefix", async () => {
		const body = samplePresetPlan("fixed-bitrate-hls-on-aws");
		let attempts = 0;
		apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
			if (url === `/api/presets/${ID}`) return detailFor(body);
			if (url === "/api/encoding-jobs" && init?.method === "POST") {
				if (++attempts === 1) throw new Error("response lost");
				return { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5" };
			}
			return [];
		});
		const view = renderWithQuery(
			<LaunchDialog presetId={ID} onClose={() => {}} />,
		);
		await screen.findByLabelText(/Job name/i);
		fireEvent.click(screen.getByRole("button", { name: /Create job/i }));
		await screen.findByText("Create failed");
		view.unmount();
		renderWithQuery(<LaunchDialog presetId={ID} onClose={() => {}} />);
		await screen.findByLabelText(/Job name/i);
		fireEvent.click(screen.getByRole("button", { name: /Create job/i }));
		await waitFor(() =>
			expect(routerPush).toHaveBeenCalledWith(
				"/vod/jobs/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5",
			),
		);
		const posts = apiFetch.mock.calls.filter(
			([url]) => url === "/api/encoding-jobs",
		);
		expect(posts).toHaveLength(2);
		const requestKey = new Headers(posts[0]?.[1].headers).get(
			"Idempotency-Key",
		);
		expect(requestKey).toMatch(/^[a-f0-9]{64}$/);
		expect(new Headers(posts[1]?.[1].headers).get("Idempotency-Key")).toBe(
			requestKey,
		);
		expect(posts[1]?.[1].body).toBe(posts[0]?.[1].body);
	});
	it("derives one prefilled source row per site — the ask-list is the plan's, never authored", async () => {
		const body = samplePresetPlan("fixed-bitrate-hls-on-aws");
		apiFetch.mockImplementation(async (url: string) => {
			if (url === `/api/presets/${ID}`) {
				return detailFor(body);
			}
			throw new Error(`unexpected ${url}`);
		});
		renderWithQuery(<LaunchDialog presetId={ID} onClose={() => {}} />);

		const sites = templateSourceSites(
			encodingPlanSchema.parse(body) as EncodingPlan,
		);
		expect(sites.length).toBeGreaterThanOrEqual(1);
		for (const site of sites) {
			const input = (await screen.findByLabelText(
				site.siteId,
			)) as HTMLInputElement;
			expect(input.value).toBe(site.currentPath);
		}
	});

	it("creates the job with the INSTANTIATED plan + provenance, then navigates", async () => {
		const body = samplePresetPlan("fixed-bitrate-hls-on-aws");
		apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
			if (url === `/api/presets/${ID}`) {
				return detailFor(body);
			}
			if (url === "/api/encoding-jobs" && init?.method === "POST") {
				return { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee6" };
			}
			throw new Error(`unexpected ${url}`);
		});
		renderWithQuery(<LaunchDialog presetId={ID} onClose={() => {}} />);

		// The name field seeds from {template} {date} — non-empty enables Create.
		const name = (await screen.findByLabelText(
			/Job name/i,
		)) as HTMLInputElement;
		expect(name.value).toMatch(/^hardened-hls \d{4}-\d{2}-\d{2}$/);

		fireEvent.click(screen.getByRole("button", { name: /Create job/i }));
		await waitFor(() => {
			expect(routerPush).toHaveBeenCalledWith(
				"/vod/jobs/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee6",
			);
		});
		const post = apiFetch.mock.calls.find(
			([url]) => url === "/api/encoding-jobs",
		);
		if (!post) {
			throw new Error("POST never fired");
		}
		const payload = JSON.parse((post[1] as RequestInit).body as string) as {
			plan: unknown;
			presetId: string;
			presetRevision: number;
		};
		// Provenance rides the create (the loaded revision, not a re-read).
		expect(payload.presetId).toBe(ID);
		expect(payload.presetRevision).toBe(3);
		// The plan is the INSTANTIATION: re-parses, and every destination sits
		// under the rendered {template}/{date}-{uuid} prefix — not the
		// template's own paths (the #87 overwrite rule).
		const plan = encodingPlanSchema.parse(payload.plan);
		const walk = (node: unknown, out: string[]): string[] => {
			if (Array.isArray(node)) {
				for (const item of node) {
					walk(item, out);
				}
			} else if (node && typeof node === "object") {
				const rec = node as Record<string, unknown>;
				if (typeof rec.outputKey === "string" && typeof rec.path === "string") {
					out.push(rec.path);
				}
				for (const v of Object.values(rec)) {
					walk(v, out);
				}
			}
			return out;
		};
		const destinations = walk(plan, []);
		expect(destinations.length).toBeGreaterThan(0);
		for (const path of destinations) {
			expect(path).toMatch(/^hardened-hls\/\d{4}-\d{2}-\d{2}-/);
		}
	});

	it("shows a named refusal instead of posting when the prefix renders empty", async () => {
		const body = samplePresetPlan("fixed-bitrate-hls-on-aws");
		apiFetch.mockImplementation(async (url: string) => {
			if (url === `/api/presets/${ID}`) {
				return detailFor(body);
			}
			throw new Error(`unexpected ${url}`);
		});
		renderWithQuery(<LaunchDialog presetId={ID} onClose={() => {}} />);

		const prefix = (await screen.findByLabelText(
			/Output prefix/i,
		)) as HTMLInputElement;
		// {ext} of an extension-bearing source is non-empty; force EMPTY by
		// clearing the template to a token that renders to nothing: "{rule}"
		// is not a launch token and renders verbatim — instead use a template
		// that is only slashes after token substitution.
		fireEvent.change(prefix, { target: { value: "/" } });
		fireEvent.click(screen.getByRole("button", { name: /Create job/i }));
		expect(
			await screen.findByText(/rendered EMPTY|overwrite/i),
		).toBeInTheDocument();
		expect(
			apiFetch.mock.calls.find(([url]) => url === "/api/encoding-jobs"),
		).toBeUndefined();
	});
});

it("asks for the withheld HTTPS source before creating a job and preserves the remaining template", async () => {
	const body = encodingPlanSchema.parse(
		samplePresetPlan("fixed-bitrate-hls-on-aws"),
	);
	const original = body.ingest[0];
	if (!original) throw new Error("Missing ingest");
	const projected = {
		...body,
		inputs: body.inputs.map((input) =>
			input.key === original.inputKey
				? {
						key: input.key,
						kind: "HTTPS",
						name: input.name,
						host: "media.example",
					}
				: input,
		),
		ingest: body.ingest.map((stream, i) =>
			i === 0 ? { ...stream, inputPath: "" } : stream,
		),
		withheldSourcePaths: [
			[{ collection: "ingest", index: 0, field: "inputPath" }],
		],
	};
	apiFetch.mockImplementation(async (url: string, init?: RequestInit) =>
		url === `/api/presets/${ID}`
			? detailFor(projected)
			: init?.method === "POST"
				? { id: ID }
				: [],
	);
	renderWithQuery(<LaunchDialog presetId={ID} onClose={() => {}} />);
	const source = await screen.findByLabelText(original.key);
	expect(source).toHaveValue("");
	const apply = screen.getByRole("button", { name: /use replacement/i });
	expect(apply).toBeDisabled();
	expect(screen.queryByRole("button", { name: /create job/i })).toBeNull();
	fireEvent.change(source, {
		target: { value: "new/source.mxf?ticket=private-fixture" },
	});
	fireEvent.click(apply);
	const launch = await screen.findByRole("button", { name: /create job/i });
	await waitFor(() => expect(launch).toBeEnabled());
	fireEvent.change(screen.getByLabelText(/output prefix/i), {
		target: { value: "{basename}-{ext}" },
	});
	fireEvent.click(launch);
	await waitFor(() => expect(routerPush).toHaveBeenCalled());
	const post = apiFetch.mock.calls.find(
		([url]) => url === "/api/encoding-jobs",
	);
	if (!post) throw new Error("Missing launched job");
	expect(JSON.parse(post[1].body).plan.ingest).toEqual(
		body.ingest.map((stream, i) =>
			i === 0
				? { ...stream, inputPath: "new/source.mxf?ticket=private-fixture" }
				: stream,
		),
	);
	const created = JSON.parse(post[1].body).plan;
	expect(created.muxings[0].destination.path).toMatch(/^source-mxf\//);
	expect(JSON.stringify(created.muxings)).not.toContain("private-fixture");
	expect(post[1].body).not.toContain("withheldSourcePaths");
});

it("reuses the creation key when a lost Quick Launch is reopened with the final replacement", async () => {
	const body = encodingPlanSchema.parse(
		samplePresetPlan("fixed-bitrate-hls-on-aws"),
	);
	const [first] = body.ingest;
	if (!first) throw new Error("Missing ingest");
	const sourceLabel = first.key;
	const projected = {
		...body,
		inputs: body.inputs.map((input) =>
			input.key === first.inputKey
				? {
						key: input.key,
						kind: "HTTPS",
						name: input.name,
						host: "media.invalid",
					}
				: input,
		),
		ingest: body.ingest.map((stream) =>
			stream === first ? { ...stream, inputPath: "" } : stream,
		),
		withheldSourcePaths: [
			[{ collection: "ingest", index: 0, field: "inputPath" }],
		],
	};
	const submissions: RequestInit[] = [];
	apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
		if (url.startsWith("/api/presets/")) return detailFor(projected);
		if (url === "/api/encoding-jobs" && init) {
			submissions.push(init);
			return submissions.length === 1 ? {} : { id: ID };
		}
		return [];
	});
	async function open(path: string) {
		const view = renderWithQuery(
			<LaunchDialog presetId={ID} onClose={() => {}} />,
		);
		fireEvent.change(await screen.findByLabelText(sourceLabel), {
			target: { value: path },
		});
		fireEvent.click(screen.getByRole("button", { name: /use replacement/i }));
		const launch = await screen.findByRole("button", { name: /create job/i });
		await waitFor(() => expect(launch).toBeEnabled());
		return { view, launch };
	}
	const finalPath = "reels/approved.mxf?ticket=PRIVATE_FIXTURE";
	const initial = await open("reels/rough.mxf?ticket=PRIVATE_FIXTURE");
	fireEvent.change(screen.getByLabelText(first.key), {
		target: { value: finalPath },
	});
	fireEvent.click(initial.launch);
	await waitFor(() => expect(submissions).toHaveLength(1));
	await waitFor(() => expect(initial.launch).toBeEnabled());
	initial.view.unmount();
	const retry = await open(finalPath);
	fireEvent.click(retry.launch);
	await waitFor(() => expect(routerPush).toHaveBeenCalledOnce());
	expect(submissions).toHaveLength(2);
	expect(submissions[0]?.headers).toEqual(submissions[1]?.headers);
	expect(JSON.parse(String(submissions[0]?.body))).toEqual(
		JSON.parse(String(submissions[1]?.body)),
	);
});

it("submits the exact Quick Launch settings clicked while offline", async () => {
	const plan = encodingPlanSchema.parse(
		samplePresetPlan("fixed-bitrate-hls-on-aws"),
	);
	const [first] = templateSourceSites(plan);
	if (!first) throw new Error("Missing source");
	apiFetch.mockImplementation(async (url: string) =>
		url.startsWith("/api/presets/")
			? detailFor(plan)
			: url === "/api/encoding-jobs"
				? { id: ID }
				: [],
	);
	renderWithQuery(<LaunchDialog presetId={ID} onClose={() => {}} />);
	const field = await screen.findByLabelText(first.siteId);
	const prefix = screen.getByLabelText(/output prefix/i);
	const launch = screen.getByRole("button", { name: /create job/i });
	await waitFor(() => expect(launch).toBeEnabled());
	fireEvent.change(field, { target: { value: "input/clicked.mxf" } });
	fireEvent.change(prefix, { target: { value: "clicked-prefix" } });
	act(() => onlineManager.setOnline(false));
	fireEvent.click(launch);
	fireEvent.change(field, { target: { value: "input/later.mxf" } });
	fireEvent.change(prefix, { target: { value: "later-prefix" } });
	act(() => onlineManager.setOnline(true));
	await waitFor(() => expect(routerPush).toHaveBeenCalledOnce());
	const call = apiFetch.mock.calls.find(
		([url]) => url === "/api/encoding-jobs",
	);
	expect(JSON.parse(String(call?.[1].body)).plan).toMatchObject({
		ingest: expect.arrayContaining([
			expect.objectContaining({
				key: first.siteId,
				inputPath: "input/clicked.mxf",
			}),
		]),
		muxings: expect.arrayContaining([
			expect.objectContaining({
				destination: expect.objectContaining({
					path: expect.stringMatching(/^clicked-prefix\//),
				}),
			}),
		]),
	});
	expect(call?.[1].headers["X-BitOVP-Create-Session"]).toBe('["org","user"]');
});

it.each([
	false,
	true,
])("replays a lost 1.3.5 Quick Launch using its original request identity (protected source: %s)", async (protectSource) => {
	const parsed = encodingPlanSchema.parse(
		samplePresetPlan("fixed-bitrate-hls-on-aws"),
	);
	const [first] = parsed.ingest;
	if (!first) throw new Error("Missing source");
	const sourcePath = "safe/replacement.mp4";
	if (protectSource) {
		parsed.inputs = parsed.inputs.map((input) =>
			input.key === first.inputKey
				? {
						key: input.key,
						kind: "HTTPS",
						host: "media.invalid",
						name: input.name,
					}
				: input,
		);
		first.inputPath = "private/original.mp4?ticket=protected-preset";
	}
	const {
		hdr10PlusStreams: _hdr,
		captionStreams: _captions,
		...presetBody
	} = parsed;
	const sources = Object.fromEntries(
		templateSourceSites(parsed).map((site) => {
			const input = parsed.inputs.find((row) => row.key === site.inputKey);
			return [
				site.siteId,
				{
					objectKey:
						protectSource && site.siteId === first.key
							? sourcePath
							: site.currentPath,
					...(input && "bucket" in input && "credentialId" in input
						? { bucket: input.bucket, credentialId: input.credentialId }
						: {}),
				},
			];
		}),
	);
	const submissions: RequestInit[] = [];
	const oldClient = createSubmissionClient(
		["org", "user", "vod", `template:${ID}:3`],
		{
			storage: sessionStorage,
			send: async (_url, init) => {
				submissions.push(init);
				throw new Error("Lost response");
			},
		},
	);
	const seed = oldClient.getSeed();
	const previous = {
		presetBody,
		sources,
		templateName: "hardened-hls",
		outputPrefixTemplate: "previous/{uuid}",
		name: "Existing launch",
		presetId: ID,
		presetRevision: 3,
		renderedAt: seed.createdAt,
	};
	await expect(
		oldClient.submit(previous, (pending) => {
			const result = instantiateTemplatePlan({
				...previous,
				now: new Date(previous.renderedAt),
				uuid: pending.nonce,
			});
			if (!result.ok) throw new Error("Invalid legacy fixture");
			const {
				hdr10PlusStreams: _hdr,
				captionStreams: _captions,
				...plan
			} = result.plan;
			return { plan, presetId: ID, presetRevision: 3 };
		}),
	).rejects.toThrow("Lost response");
	apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
		if (url.startsWith("/api/presets/")) {
			return detailFor(
				protectSource
					? {
							...presetBody,
							ingest: parsed.ingest.map((stream) =>
								stream === first ? { ...stream, inputPath: "" } : stream,
							),
							withheldSourcePaths: [
								[{ collection: "ingest", index: 0, field: "inputPath" }],
							],
						}
					: presetBody,
			);
		}
		if (url === "/api/encoding-jobs" && init) {
			submissions.push(init);
			return { id: ID };
		}
		return [];
	});
	renderWithQuery(<LaunchDialog presetId={ID} onClose={() => {}} />);
	if (protectSource) {
		fireEvent.change(await screen.findByLabelText(first.key), {
			target: { value: sourcePath },
		});
		fireEvent.click(screen.getByRole("button", { name: /use replacement/i }));
	}
	const launch = await screen.findByRole("button", { name: /create job/i });
	await waitFor(() => expect(launch).toBeEnabled());
	fireEvent.change(screen.getByLabelText(/output prefix/i), {
		target: { value: previous.outputPrefixTemplate },
	});
	fireEvent.change(screen.getByLabelText(/job name/i), {
		target: { value: previous.name },
	});
	fireEvent.click(launch);
	await waitFor(() => expect(routerPush).toHaveBeenCalledOnce());
	expect(submissions).toHaveLength(2);
	expect(new Headers(submissions[0]?.headers).get("Idempotency-Key")).toBe(
		new Headers(submissions[1]?.headers).get("Idempotency-Key"),
	);
	const original: unknown = JSON.parse(String(submissions[0]?.body));
	if (protectSource) {
		expect(submissions[1]?.method).toBe("GET");
		expect(submissions[1]?.body).toBeUndefined();
		expect(
			new Headers(submissions[1]?.headers).get(
				"X-BitOVP-Create-Request-Digest",
			),
		).toBe(
			createHash("sha256")
				.update(canonicalCreateRequestJson(original))
				.digest("hex"),
		);
	} else {
		expect(submissions[1]?.method).toBe("POST");
		expect(JSON.parse(String(submissions[1]?.body))).toEqual(original);
	}
});
