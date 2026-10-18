import { AsyncLocalStorage } from "node:async_hooks";
import { tenantQueueEnvelopeSchema } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";

const organizations = new AsyncLocalStorage<string>();
const instances = new WeakMap<object, Map<string, object>>();

export function currentOrganizationId(): string | undefined {
	return organizations.getStore();
}

export function requireOrganizationId(): string {
	const id = currentOrganizationId();
	if (!id) throw new Error("Organization context is required");
	return id;
}

export function runInOrganization<T>(organizationId: string, run: () => T): T {
	tenantQueueEnvelopeSchema.shape.organizationId.parse(organizationId);
	return organizations.run(organizationId, run);
}

/** Select the fixed facade when a command is CREATED, never when it is awaited. */
export function contextualTenantPrisma(
	resolveClient: (organizationId: string) => AppPrismaClient,
	marker: symbol,
): AppPrismaClient {
	const delegates = new Map<PropertyKey, object>();
	return new Proxy({} as AppPrismaClient, {
		get(_target, key) {
			if (key === marker) return currentOrganizationId();
			if (key === "then") return undefined;
			if (typeof key === "string" && key.startsWith("$")) {
				return (...args: unknown[]) => {
					const fixed = resolveClient(requireOrganizationId());
					const method = Reflect.get(fixed, key);
					return Reflect.apply(method, fixed, args);
				};
			}
			let delegate = delegates.get(key);
			if (!delegate) {
				delegate = new Proxy(
					{},
					{
						get(_delegate, method) {
							if (method === "then") return undefined;
							return (...args: unknown[]) => {
								const fixed = resolveClient(requireOrganizationId());
								const owner = Reflect.get(fixed, key);
								return Reflect.apply(Reflect.get(owner, method), owner, args);
							};
						},
					},
				);
				delegates.set(key, delegate);
			}
			return delegate;
		},
	});
}

/** Each organization's service keeps its own cursors, caches, leases and registries. */
export function tenantService<T extends object>(factory: () => T): T {
	const services = new Map<string, T>();
	const service = () => {
		const id = requireOrganizationId();
		let instance = services.get(id);
		if (!instance) {
			instance = factory();
			services.set(id, instance);
		}
		return instance;
	};
	const proxy = new Proxy(() => {}, {
		apply(_target, receiver, args) {
			return Reflect.apply(
				service() as unknown as (...args: unknown[]) => unknown,
				receiver,
				args,
			);
		},
		get(_target, key) {
			if (key === "then") return undefined;
			return (...args: unknown[]) => {
				const instance = service();
				const method = Reflect.get(instance, key);
				if (typeof method !== "function")
					throw new Error("Unknown tenant service method");
				return Reflect.apply(method, instance, args);
			};
		},
	}) as unknown as T;
	instances.set(proxy, services);
	return proxy;
}

/** Shutdown visits only services already instantiated, without needing a healthy DB. */
export function forEachTenantService<T extends object, R>(
	facade: T,
	run: (service: T) => R,
): R[] {
	return [...(instances.get(facade)?.entries() ?? [])].map(([id, instance]) =>
		runInOrganization(id, () => run(instance as T)),
	);
}
