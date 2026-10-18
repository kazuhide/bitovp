import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import { act, type ReactNode } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { FeatureFlagsProvider } from "@/lib/feature-flags/context";
import { LocaleProvider } from "@/lib/i18n/context";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { JobsClient } from "./jobs-client";

const storage = new Map<string, string>();
const originalLocalStorage = Object.getOwnPropertyDescriptor(
	globalThis,
	"localStorage",
);
const localStorageStub: Storage = {
	get length() {
		return storage.size;
	},
	clear: () => storage.clear(),
	getItem: (key) => storage.get(key) ?? null,
	key: (index) => [...storage.keys()][index] ?? null,
	removeItem: (key) => storage.delete(key),
	setItem: (key, value) => storage.set(key, String(value)),
};

function tree(client: QueryClient, children: ReactNode) {
	return (
		<LocaleProvider locale="en">
			<QueryClientProvider client={client}>
				<FeatureFlagsProvider flags={{ qcVmaf: true }}>
					{children}
				</FeatureFlagsProvider>
			</QueryClientProvider>
		</LocaleProvider>
	);
}

beforeEach(() => {
	storage.clear();
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: localStorageStub,
	});
	apiFetch.mockImplementation(async (input: string) => {
		if (input === "/api/auth/session") {
			return {
				mode: "password",
				configured: true,
				authenticated: true,
				loginKind: "password-form",
			};
		}
		return { items: [] };
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(() => {
	if (originalLocalStorage) {
		Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
	} else {
		Reflect.deleteProperty(globalThis, "localStorage");
	}
});

it("hydrates before applying browser-saved columns", async () => {
	localStorage.setItem("ovp-vod-jobs-columns", JSON.stringify(["status"]));

	const browserWindow = window;
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: undefined,
	});
	let html: string;
	try {
		html = renderToString(tree(new QueryClient(), <JobsClient />));
	} finally {
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: browserWindow,
		});
	}

	const container = document.createElement("div");
	container.innerHTML = html;
	document.body.append(container);
	const onRecoverableError = vi.fn();
	let root: ReturnType<typeof hydrateRoot> | undefined;
	await act(async () => {
		root = hydrateRoot(container, tree(new QueryClient(), <JobsClient />), {
			onRecoverableError,
		});
	});

	try {
		await waitFor(() => {
			expect(container.textContent).not.toContain("Labels");
		});
		expect(onRecoverableError).not.toHaveBeenCalled();
	} finally {
		await act(async () => {
			root?.unmount();
		});
		container.remove();
	}
});
