# Verification capability prerequisites

When running the optional verification tools, preflight reports which resources
and credentials a scenario needs. Availability is checked for each execution;
a saved credential alone does not establish that a scenario can run.

Use the following table to resolve a named missing capability. Verification
can create billable resources; use dedicated inputs/outputs and bounded runs.

| Capability | What satisfies it | Preflight evidence |
|---|---|---|
| S3 | AWS S3 credential and the configured verification buckets | credential decrypt plus applicable list/read probe |
| AKAMAI | Akamai/Linode Object Storage credential used through GenericS3 | provider kind, endpoint validation, list/read probe |
| AKAMAI_MSL | Akamai-provisioned stream identity (`streamId` and `eventName`); the credential's optional `edgeBaseUrl` is the default edge base for the delivery-edge closure (`--live-msl-edge-base-url` overrides; a value off the delivery-host allowlist is INVALID before spend unless `VERIFY_LIVE_MSL_EDGE_ALLOWED_HOSTS` names it) | decryptable `AKAMAI_MSL` credential with complete provisioning fields |
| LIVE_MEDIA_INGEST | Live Media and Metadata Ingest compatible Origin | receiver acceptance is outside the storage harness; no automatic runnable claim |
| AKAMAI_NETSTORAGE | NetStorage upload account (host, username, password) | complete provider credential; read-back remains a separate observer limit |
| GCS | GCS HMAC interoperability credential | credential decrypt plus applicable list/read probe |
| GCS_SERVICE_ACCOUNT | GCS service-account JSON credential | provider-specific credential validation and probe |
| AZURE | Azure Blob account/key credential | provider-specific credential validation and probe |
| SFTP | Reachable SFTP host and credential | connection probe; encoder output read-back may still be unavailable |
| GENERIC_ASSETS | Harness-generated generic mezzanine assets | bootstrap confirms every required object identity |
| TYPED_SOURCE_ASSETS | Role-correct subtitle/audio/video source assets | source-role census confirms every plan input can be bound without substitution |
| DOLBY_ASSETS | Dolby Vision/Atmos masters and required sidecars | exact staged object identities and media roles |
| HDR10_ASSET | HDR10 mezzanine | exact staged object identity and media probe |
| KANTAR | Kantar credential and permitted service endpoint | credential validation plus egress preflight |
| ZIXI | Reachable Zixi broadcaster and credential | external source/connectivity probe |
| POIS | Reachable POIS endpoint and credential | HTTPS/allowlist validation plus connectivity probe |
| DRM_CREDENTIAL | CENC/FairPlay key-provider credential matching the scenario | provider type and required secret-field validation |
| NEXGUARD | NexGuard licence credential | provider type and required secret-field validation |
| LIVE_INFRA | Live encoder capacity in the selected account and region | per-run provider preflight; historical capacity is not proof |
| SRT_SOURCE | Reachable external SRT sender for caller mode | external source/connectivity probe |
| PINNED_ENCODER_VERSION | Literal encoder build verified available to the account | provider version lookup or an explicitly registered measured capability |

Credential presence alone is not success. If the applicable probe fails, the
capability remains unsatisfied and the scenario is a named SKIP. If preflight
declares it satisfied and the provider later fails, that is a runtime verdict,
not an environment relabeling.
