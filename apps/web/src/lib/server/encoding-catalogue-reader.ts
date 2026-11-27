import type BitmovinApi from "@bitmovin/api-sdk";

type ReadDetail = (api: BitmovinApi, id: string) => Promise<unknown>;

export type EncodingCatalogueReader = {
	list: (
		api: BitmovinApi,
		page: { offset: number; limit: number },
	) => Promise<unknown>;
	get: ReadDetail;
	readType?: ReadDetail;
} & (
	| { metadata: ReadDetail; expectedType: string }
	| { metadata?: never; expectedType?: never }
);
