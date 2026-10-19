# Troubleshooting

[Back to the user guide](../USER-GUIDE.md)

Check the failed layer in order: browser/API request, queue/worker, provider,
input, encoding, origin files, delivery/player, then quality measurement.

| Symptom | First checks |
|---|---|
| Protected pages return 503 | Authentication mode, required secret/hash, literal quotes or inline comments in `.env` |
| Compose rejects `format` | Docker Compose 2.30.0 or newer is required |
| Setup unavailable | Per-user mode, zero existing users, and HTTPS or explicit local HTTP exception |
| Job remains queued | Worker/queue health and enqueue errors in job details |
| VOD `ERROR` | Last failed step, provider error category, input/output permissions and paths |
| `FINISHED` but no playback | Manifest, media segments, storage permissions, CORS, CDN, and player |
| Live `RUNNING` but no picture | Input `CONNECTED` and freshness, receive details, output progression, then player |
| Feeder `PUSHING` only | Destination channel input connection and fresh receive information |
| Schedule `FIRED` only | Action result and actual media outcome |
| Unexpectedly low VMAF | Reference/output identity, time/frame alignment, model, sampling, and resolution |
| Missing quality renditions | Expected count, QC output availability, output identity, and read permission |
| Missing controls | Current organization role and feature availability |

## Creation response lost

If creating a VOD job or Live channel times out, retry from the same form with
the same settings. The wizards and template launch dialogs remember that
creation in the current browser tab, so a retry returns the original resource
instead of creating another one. After reloading, restore any settings omitted
from the saved draft before retrying.

Changing settings or opening a separate new tab can create new work. Check the
job or channel list before starting over or clearing browser session data.
Successful creation and an intentional subsequent launch are separate operations.
If browser session storage is unavailable, creation stops before sending the
request; allow storage for the application and try again.

If the original resource was deleted, its old creation request is refused.
Create new work deliberately after reviewing output paths. If the existing
resource shows a queue error, use its retry or start action from the detail page.

## Investigate a 404

1. Copy the exact output URL from the affected job or run.
2. Check the manifest separately from the media URLs it references.
3. If origin exists but CDN returns 404, check hostname, base path, routing,
   activation, and cache behavior.
4. If origin is missing, check output paths, placeholders, and provider resources.
5. Keep each result tied to the same run and output. Finding a different URL
   does not establish success for the original one.

For a newly starting HLS Live preview, the player can wait for the first manifest
and media. Waiting is not a playback success. Check incoming media and the HLS
publication buffer; use the player's retry action after resolving the cause.

## Interpret states carefully

- `QUEUED`: waiting for processing.
- `RUNNING`: worker/encoder is active; input/output/playback still need checking.
- `CONNECTED`: observed live input connection; does not prove delivery.
- `PUSHING`: feeder is sending; does not prove provider receipt.
- `FIRED`: scheduled action dispatched; does not prove the intended media result.
- `FINISHED`: encoding ended; does not prove complete delivery or playback.

## Stop or cancel

Check both local and provider terminal state. For Live, check feeder, channel,
and provider encoding. A deleted local row or a recorded stop request does not
by itself confirm that an external billable resource stopped. Keep cleanup
ownership and credentials until termination is verified.

## Share a useful issue report

Include time and time zone, app build, affected screen, expected and actual
behavior, status/error code, last step, input/output types, and which delivery
layers you checked. Include retry, stop, and cleanup outcomes.

Remove API keys, storage secrets, stream keys, signed query strings, private
hostnames, account identifiers, and confidential media names before posting a
public issue. Keep sensitive resource identifiers in your private incident record.
