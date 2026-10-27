# Manifest options

A manifest tells a player which tracks are available and where to read them. A container determines how media files are written; a manifest selects and describes those files. Configure the containers first, then open **Manifests → Additional manifest options**.

Leave optional settings blank to keep the Encoding API default. `false` and `0` are explicit values, and differ from a blank field. Advanced fields retain their API names so that they can be compared with the Bitmovin reference.

## HLS

`channelsAttributeForAudio` controls the audio `CHANNELS` attribute. `targetDurationRoundingMode` chooses normal or upward rounding of the target duration. These settings affect playlist compatibility; they do not change the encoded segment length.

The `audioMedia` and `subtitleMedia` sections configure associated language, accessibility characteristics, default/automatic selection and optional segment ranges. `streams` configures variant attributes, video-group references and prioritized audio groups. Audio-group names must match groups already configured in the ladder.

Use `additionalMedia` for video groups, closed captions or an external WebVTT file. Select an existing container for video and closed captions. An external WebVTT entry needs a public HTTP or HTTPS `vttUrl` and a distinct child playlist filename in `uri`. The URL must not include a username, password, query string (`?`) or fragment (`#`). Signed URLs are not supported because plans and saved presets store readable configuration. This restriction also applies to external DASH WebVTT representations. Use a publicly readable subtitle URL. For private VOD subtitles, configure an encoded subtitle track with a saved storage credential instead. Subtitle languages must use one subtitle group. Video and closed-caption groups are referenced by the variant's `video` and `closedCaptions` settings.

`mediaCustomTags` adds tags to media playlists, including additional video, caption and subtitle entries; `streamCustomTags` adds them to variant playlists, including audio-only and generated Per-Title variants. Each tag specifies a time in seconds, a segment number or an existing keyframe. A keyframe must belong to the encoding that produces the playlist. Use separate entries for separate tag lines. Avoid adding advertising tags when automatic ad markers already generate them.

## DASH

Global options include edition compatibility, timestamp format, `minBufferTime` in seconds, additional XML namespaces and UTC synchronization entries. UTC timing values and schemes must describe a timing service supported by the player.

The `period` section provides optional start/duration values in seconds and custom XML elements. An explicit duration overrides the duration derived from media. Leave it blank unless the presentation needs a particular duration.

Video, audio and subtitle adaptation sets can carry roles, accessibility descriptors, custom attributes and labels with language codes. The same controls are available for explicitly configured adaptation sets.

In `representations`, select an existing container to set its segment range, keyframe range or dependency on another representation. Keyframe IDs take precedence over segment numbers in the Encoding API. The ending keyframe's segment is excluded. Both keyframes must belong to the selected encoding, and the end must follow the start. A dependency must refer to another static representation included in the same manifest. Cycles are rejected. Per-Title result IDs become known after analysis, so per-container overrides require standard streams.

For encrypted fMP4, the DRM representation option uses the selected container's encryption configuration. Content protection can be attached to the representation or its adaptation set; references are resolved from the selected resources. This does not create a content key or a license service.

`additionalRepresentations` supports an external WebVTT file, a configured sprite track or a progressive WebM output. For progressive WebM, enable **Single WebM file** on the WebM container and set a filename. Sprites and external subtitles receive their own matching adaptation sets.

## Live channels

Live uses the same additional-options sections for HLS and DASH. Global values, initial Period metadata, adaptation-set descriptors, segment ranges, dependencies, encrypted fMP4 representations, external subtitles and custom tags are available where their containers support them. The controls do not change the Live encoding start or ingest settings.

The DVR budget counts each distinct generated segment list. An additional HLS video entry with its own playlist filename adds a full list even when it uses an existing container. Closed captions and external WebVTT references add no full DVR segment list. Delivery mirrors copy the same lists and do not multiply the estimate.

Use time or segment positions for Live custom tags. Live setup does not expose VOD keyframe IDs. Sprite tracks, progressive WebM and post-encoding Default generation apply to VOD; they are not offered for Live. A fixed Live Period duration should be used only when the intended presentation requires it.

## Default manifest generation

**Use the configured tracks** keeps explicit media groups and representation trees. **Default API** lets Bitmovin select tracks after encoding and therefore changes generation timing to post-encoding. Selecting it replaces manual track options with the global settings supported by that API.

Default HLS uses the encoding assigned to the plan's first rendition. Bitmovin chooses child playlist names and media groups. Clear custom per-track names and playlist URIs before selecting it. A separate manual HLS manifest can still use those shared settings.

The checks follow generated playlists to declared media files and verify codec, resolution, audio properties and bytes. Multiple compatible containers remain possible choices until generated output identifies them.

A flexible Per-Title template can be omitted from the generated ladder; a fixed-resolution template remains required. TS and fragmented MP4 copies of one video stream represent the same ladder rung.

Default DASH can use multiple periods, with selected encodings and attribute conditions for each adaptation set. Conditions support AND/OR groups. Numeric condition values are written in API units, such as pixels and bits per second. Keep conditions shallow enough to inspect: the editor supports eight nested groups and the plan accepts at most 128 condition nodes per adaptation-set condition.

Per-Title verification uses the encoder's recorded results for the selected tracks. If those results or required source metadata are unavailable, the affected comparison remains unverified; known codec and track-count checks still run.

## Saving and checking settings

Plans and saved jobs retain the complete configuration. Browser draft recovery stores safe configuration fields; URLs, custom XML and custom tag payloads are excluded from browser storage. Save the job or export its Plan JSON to retain those fields. Encoding-template YAML export is unavailable for these advanced settings and progressive WebM; use the app or Plan JSON.

These controls configure the Encoding API. Availability still depends on the encoder version, codec, container and account. Check the generated manifest and playback on the intended devices when adopting a new combination.

Reference: [DASH manifests](https://bitmovin.github.io/bitmovin-api-sdk-javascript/classes/DashManifest.html), [segmented representation ranges](https://bitmovin.github.io/bitmovin-api-sdk-javascript/classes/DashSegmentedRepresentation.html), [HLS stream information](https://bitmovin.github.io/bitmovin-api-sdk-javascript/classes/StreamInfo.html).
