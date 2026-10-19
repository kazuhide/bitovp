# Getting started

[Back to the user guide](../USER-GUIDE.md)

## Try the browser demo

The [feature guide](https://kazuhide.github.io/bitovp/) and demo are also available
[in Japanese](https://kazuhide.github.io/bitovp/ja/). Use the language links to switch
between English and Japanese.

Open the [interactive demo](https://kazuhide.github.io/bitovp/#/demo) to explore
the dashboard, example jobs, Live monitoring, quality reports, and encoding forms
without an account. Created jobs and their progress are simulated. Demo jobs
stay in the current browser tab. **Reset demo** clears those jobs and demo form
drafts. Display preferences remain in your browser.

The demo does not connect to Bitmovin or storage services. Use sample references
when editing forms; do not enter credentials or signed media URLs. Some workspace
tools and operations are available only in the installed application, including
scheduled starts, runtime caps, media playback, and quality computation. The
sample quality scores are illustrative.

## Sign in and choose your organization

Complete [installation](./INSTALLATION.md), then open **http://localhost:3100**.
In per-user authentication mode, the first administrator completes `/setup`;
later visits use `/login`. Check the current organization in navigation before
creating or changing anything. Data is shared within that organization.

Choose English or Japanese and your preferred theme in `/settings`.

## Connect Bitmovin and storage

An `ADMIN` performs account and credential registration, updates, deletion, and
connection tests. `OPERATOR` can use configured accounts and browse storage.

1. Open `/settings/bitmovin` and add the Bitmovin API key. Supply a Bitmovin
   organization ID when your account requires one, then test the connection.
2. Open `/settings/credentials` and add input and output access for your storage
   provider. Choose the correct provider and endpoint; S3-compatible storage is
   not always configured like AWS S3.
3. Open `/storage`, select the credential and bucket/container, and locate a
   small input file. Confirm that the account can list and read it.
4. Choose an output bucket/container and a dedicated prefix for the encoding.
   A prefix is the beginning of an object path, such as `encodings/demo/`.
   Keep output separate from watched input folders.
5. Open `/vod/new` or `/live/new`, select the account, and configure the job.

Saved secret values are encrypted and are not shown again. Store replacement
keys securely and rotate them through the relevant credential settings.
The application's organization and a Bitmovin organization are separate scopes.
Using the same external credential in two application organizations grants both
access to that external account or storage.

## Preview playback

`/settings/player` controls VOD and Live preview playback. By default, HLS uses
hls.js and DASH uses Shaka Player, without sending Bitmovin Analytics data.
Bitmovin Player requires a public client license key. Its optional Analytics key
is also a browser client key. Never put an Encoding API key or storage secret in
either field.

The browser must be able to fetch the manifest and media. Check storage/CDN
permissions and cross-origin resource sharing (CORS) if the preview cannot load.

## Your first check

Use a short input, a new output prefix, and one video/audio pair. Inspect the
review screen, then start the job. After it finishes, open the output and play
both video and audio. See [VOD](./VOD.md) or [Live](./LIVE.md) for the full workflow.
