import type BitmovinApi from "@bitmovin/api-sdk";
import type { ResourceAddress } from "./family";

export type Child = {
	id?: string;
	type?: string;
	typeDiscriminator?: string;
	name?: string;
	createdAt?: Date;
	modifiedAt?: Date;
	positionMode?: string;
	time?: number;
	frame?: number;
	frameId?: string;
	method?: string;
};
export type Page = { offset: number; limit: number };
export type ChildPage<T = Child> = {
	items?: T[];
	totalCount?: number;
	offset?: number;
};
export type Metadata = { customData?: Record<string, unknown> };
export type ChildDiscriminator = {
	field: "type" | "typeDiscriminator";
	value: string;
};
type FieldRule = "number" | "boolean" | readonly string[];
type Collection<T> = {
	label: string;
	liveOnly?: boolean;
	encodingScope?: boolean;
	wholeCollection?: boolean;
	expectedDiscriminator?: ChildDiscriminator;
	list(
		api: BitmovinApi,
		address: ResourceAddress,
		page: Page,
	): Promise<ChildPage<T>>;
	get?(api: BitmovinApi, address: ResourceAddress, childId: string): Promise<T>;
	metadata?(
		api: BitmovinApi,
		address: ResourceAddress,
		childId: string,
	): Promise<Metadata>;
};
export type ResourceChildCollection = Collection<Child> & {
	fields?: Readonly<Partial<Record<string, FieldRule>>>;
};
export type ResourceChildren = Record<
	string,
	Record<string, ResourceChildCollection>
>;

export function defineChildCollection<T extends Child>(
	definition: Collection<T> & {
		fields: Partial<Record<(NoInfer<keyof T> & string) | "type", FieldRule>>;
	},
): ResourceChildCollection {
	return definition;
}
