import type { VodInputFavoriteWire } from "@bitovp/core/vod-input-timeline";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentOrganizationContext } from "@/components/providers";
import { LocaleProvider } from "@/lib/i18n/context";
import { SourceBin } from "./source-bin";

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/api", async (original) => ({
	...(await original<object>()),
	apiFetch: api.fetch,
}));
vi.mock("@/components/storage-picker", () => ({
	StoragePicker: ({
		open,
		onSelect,
	}: {
		open: boolean;
		onSelect: (value: unknown) => void;
	}) =>
		open ? (
			<button
				type="button"
				onClick={() =>
					onSelect({ credentialId: id, bucket: "input", path: "logo.png" })
				}
			>
				画像を選択
			</button>
		) : null,
}));
const id = "00000000-0000-4000-8000-000000000001";
const favorite: VodInputFavoriteWire = {
	id,
	credentialId: id,
	bucket: "input",
	objectKey: "intro.mp4",
	label: "Intro",
	kind: "VIDEO",
	availability: "AVAILABLE",
	inputKind: "S3",
};
const fact = {
	key: "main",
	durationMs: 5000,
	video: { streamIndex: 0, width: 1280, height: 720 },
	audio: null,
	identity: { size: 100, etag: "fixed" },
};
const source = {
	key: "main",
	inputKey: "input",
	kind: "S3" as const,
	credentialId: id,
	bucket: "input",
	path: "main.mp4",
};
function view(extra: Partial<Parameters<typeof SourceBin>[0]> = {}) {
	return (
		<DocumentOrganizationContext.Provider value={id}>
			<LocaleProvider locale="ja">
				<SourceBin
					sources={[source]}
					facts={[fact]}
					selectedKey={null}
					disabled={false}
					canAdd={() => true}
					onSelect={vi.fn()}
					onAdd={vi.fn()}
					onAddSource={vi.fn()}
					onUseFavorite={vi.fn()}
					canUseLogo
					canUseMedia
					{...extra}
				/>
			</LocaleProvider>
		</DocumentOrganizationContext.Provider>
	);
}
beforeEach(() => {
	api.fetch.mockReset().mockResolvedValue({ favorites: [favorite] });
});

describe("fixed VOD source bin", () => {
	it("can prepare an image on V1 before a main video exists, independently of output logos", async () => {
		const onUse = vi.fn(),
			onPrepare = vi.fn();
		const image = {
			...favorite,
			kind: "IMAGE",
			objectKey: "cover.png",
			label: "Cover",
		};
		api.fetch.mockResolvedValue({ favorites: [image] });
		render(
			view({
				sources: [],
				facts: [],
				canUseLogo: false,
				onUseFavorite: onUse,
				onPrepareImage: onPrepare,
			}),
		);
		expect(
			await screen.findByRole("button", { name: "Coverを出力ロゴに使用" }),
		).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "CoverをV1に配置" }));
		await waitFor(() => expect(onPrepare).toHaveBeenCalledWith(image));
		expect(api.fetch).toHaveBeenCalledTimes(2);
		expect(onUse).not.toHaveBeenCalled();
	});
	it("does not open image preparation after leaving while refresh ignores abort", async () => {
		const onPrepare = vi.fn();
		const image = {
			...favorite,
			kind: "IMAGE",
			objectKey: "cover.png",
			label: "Cover",
		};
		let reply: ((value: unknown) => void) | undefined;
		api.fetch
			.mockResolvedValueOnce({ favorites: [image] })
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						reply = resolve;
					}),
			);
		const rendered = render(view({ onPrepareImage: onPrepare }));
		fireEvent.click(
			await screen.findByRole("button", { name: "CoverをV1に配置" }),
		);
		rendered.unmount();
		await act(async () => reply?.({ favorites: [image] }));
		expect(onPrepare).not.toHaveBeenCalled();
	});
	it("does not load or show an unusable favorites feature without a wizard callback", () => {
		render(view({ onUseFavorite: undefined }));
		expect(
			screen.queryByRole("heading", { name: "固定素材" }),
		).not.toBeInTheDocument();
		expect(api.fetch).not.toHaveBeenCalled();
	});
	it("reloads the registry before using a reference and shows output-logo meaning explicitly", async () => {
		const onUse = vi.fn();
		api.fetch.mockResolvedValue({
			favorites: [
				{ ...favorite, kind: "IMAGE", objectKey: "logo.png", label: "Logo" },
			],
		});
		render(view({ onUseFavorite: onUse }));
		fireEvent.click(
			await screen.findByRole("button", { name: "Logoを出力ロゴに使用" }),
		);
		await waitFor(() => expect(onUse).toHaveBeenCalledTimes(1));
		expect(api.fetch).toHaveBeenCalledTimes(2);
		expect(
			screen.getByText(/入力プレビューには表示されません/),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Logoを素材へ追加" }),
		).not.toBeInTheDocument();
	});
	it("refuses a credential removed between display and use, while keeping removal available", async () => {
		const onUse = vi.fn();
		api.fetch
			.mockResolvedValueOnce({ favorites: [favorite] })
			.mockResolvedValue({
				favorites: [
					{
						...favorite,
						availability: "CREDENTIAL_UNAVAILABLE",
						inputKind: null,
					},
				],
			});
		render(view({ onUseFavorite: onUse }));
		fireEvent.click(
			await screen.findByRole("button", { name: "Introを素材へ追加" }),
		);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"資格情報がありません",
		);
		expect(onUse).not.toHaveBeenCalled();
		expect(
			screen.getByRole("button", { name: "Introを固定素材から外す" }),
		).toBeEnabled();
	});
	it("saves a probed loaded source and removes only its favorite reference", async () => {
		let items: unknown[] = [];
		api.fetch.mockImplementation(async (_url, init) => {
			if (init?.method === "POST") {
				items = [
					{
						...JSON.parse(init.body),
						id,
						availability: "AVAILABLE",
						inputKind: "S3",
					},
				];
				return { favorite: items[0] };
			}
			if (init?.method === "DELETE") {
				items = [];
				return undefined;
			}
			return { favorites: items };
		});
		render(view());
		const save = await screen.findByRole("button", {
			name: "main.mp4を固定素材へ保存",
		});
		await waitFor(() => expect(save).toBeEnabled());
		fireEvent.click(save);
		const remove = await screen.findByRole("button", {
			name: "main.mp4を固定素材から外す",
		});
		fireEvent.click(remove);
		await waitFor(() =>
			expect(
				screen.queryByRole("button", { name: "main.mp4を固定素材から外す" }),
			).not.toBeInTheDocument(),
		);
		expect(
			screen.getByRole("button", { name: "main.mp4をプレビュー" }),
		).toBeInTheDocument();
		expect(api.fetch).toHaveBeenCalledWith(
			"/api/vod/input-favorites",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					credentialId: id,
					bucket: "input",
					objectKey: "main.mp4",
					label: "main.mp4",
					kind: "VIDEO",
				}),
			}),
		);
	});
	it("registers a PNG through the picker with an explicit image kind", async () => {
		api.fetch.mockResolvedValue({ favorites: [] });
		render(view());
		fireEvent.click(
			await screen.findByRole("button", { name: "固定素材を追加" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "画像を選択" }));
		expect(screen.getByRole("combobox", { name: "素材の種類" })).toHaveValue(
			"IMAGE",
		);
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		await waitFor(() =>
			expect(api.fetch).toHaveBeenCalledWith(
				"/api/vod/input-favorites",
				expect.objectContaining({
					method: "POST",
					body: expect.stringContaining('"kind":"IMAGE"'),
				}),
			),
		);
	});
	it("shows actual request failures instead of an empty-success state", async () => {
		api.fetch.mockRejectedValue(new Error("private diagnostics"));
		render(view());
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"固定素材を読み込めませんでした",
		);
		expect(screen.queryByText("private diagnostics")).not.toBeInTheDocument();
	});
	it("uses the latest project callback after the asynchronous credential refresh", async () => {
		let reply: ((value: unknown) => void) | undefined;
		api.fetch
			.mockResolvedValueOnce({ favorites: [favorite] })
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						reply = resolve;
					}),
			);
		const old = vi.fn(),
			current = vi.fn(),
			rendered = render(view({ onUseFavorite: old }));
		fireEvent.click(
			await screen.findByRole("button", { name: "Introを素材へ追加" }),
		);
		rendered.rerender(view({ onUseFavorite: current }));
		if (!reply) throw new Error("Expected pending registry refresh");
		reply({ favorites: [favorite] });
		await waitFor(() => expect(current).toHaveBeenCalledTimes(1));
		expect(old).not.toHaveBeenCalled();
	});
	it("shows a synchronous project guard failure without claiming the source was imported", async () => {
		render(
			view({
				onUseFavorite: () => {
					throw new Error("FAVORITE_SOURCE_LIMIT");
				},
			}),
		);
		fireEvent.click(
			await screen.findByRole("button", { name: "Introを素材へ追加" }),
		);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"素材の上限に達しています",
		);
	});
});
