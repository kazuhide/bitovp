# Glossary

[Back to the user guide](../USER-GUIDE.md)

| Term | Meaning in this application |
|---|---|
| VOD | Video on demand: encode stored media for later playback |
| Live channel | Persistent settings and history for a live service |
| Run | One broadcast of a channel, with its own encoding and output identity |
| Ingest | Media arriving from a contribution encoder or pulled input |
| Rendition | One encoded representation, such as a particular resolution and bitrate |
| Ladder | A collection of video/audio renditions for adaptive playback |
| Codec | A method for compressing video or audio, such as H.264 or AAC |
| Muxing | Packing one or more streams into a container such as TS or MP4 |
| fMP4 | Fragmented MP4, commonly used for segmented delivery |
| CMAF | Common Media Application Format; a media format used for compatible segmented delivery |
| Manifest | An HLS playlist or DASH document describing media and rendition choices |
| HLS / DASH | HTTP adaptive streaming formats that let a player select segments/renditions |
| Audio group | HLS relationship linking separate audio renditions to video variants |
| DVR / timeshift | How far back a viewer can seek behind a live edge |
| Heartbeat | Periodic live-encoding information; it is separate from direct playback evidence |
| Pseudo-live / feeder | Send a stored file in real time to a live input |
| Slate | Insertable still image or video, checked against the live ingest format |
| Per-Title | Source analysis that chooses content-dependent output renditions |
| VMAF | Reference-based video-quality measurement calculated with libvmaf |
| QC gate | Quality-control rules that can hold delivery until results meet a policy |
| Preset | Reusable encoding or delivery settings |
| Credential | Stored access information for a provider, input/output, DRM, or integration |
| Prefix | Beginning of an object-storage path, used to group related files |
| Step history | Recorded progress and provider operations for a job or broadcast |
| Organization | Application data and role scope; separate from a Bitmovin organization |
| CORS | Cross-origin resource sharing: browser permission to fetch media from another origin |
| DRM | Digital rights management: encryption plus the license workflow required for playback |
| SCTE-35 | Signaling for program and advertising events in a stream |

State codes such as `RUNNING`, `CONNECTED`, and `FINISHED` keep their API spelling
in both UI languages so you can match them with provider status and logs.
