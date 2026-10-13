# Home Assistant

Home Assistant instances, with browser sign-in or a long-lived access token.

Maintained independently from [Switchboard](https://github.com/tader/switchboard).

## Installation

Open **Plugins → Community** in Switchboard and install **Home Assistant**. Alternatively use **Install from GitHub** with repository `tader/switchboard-plugin-home-assistant` and path `plugins/home-assistant`. Review the dependency preview and apply it.

Dependencies: `oauth2` (^1.0.0), `api-key` (^1.0.0). Missing external dependencies are resolved through the live community catalog; OAuth and API Keys are built into Switchboard.

## Existing installations

Install this repository before upgrading a Switchboard instance that bundles `home-assistant`. The plugin ID, service IDs, authentication methods, settings and persistent data paths are preserved. Installed plugins replace the built-in copy. Existing connections and saved calls continue to work; keep the instance data directory and encryption key.

## Logs and Lovelace over WebSocket

Requires a Switchboard build with managed WebSocket operations (as implemented in `~/switchboard`). Existing OAuth and long-lived token connections work with the same credentials; REST operations remain available alongside WebSocket operations.

The connection's WebSocket console and Switchboard API/MCP expose these dedicated operations:

| Operation | Mode | Purpose |
| --- | --- | --- |
| `system_log/list` | Command | Recent condensed warnings and errors, newest first; requires an admin. |
| `system_log/subscribe` | Subscription | Live `system_log_event` events; requires `system_log.fire_event: true` in Home Assistant. |
| `system_log/subscribe_raw` | Subscription | Raw log lines and an initial backlog, with optional `integration` filter; requires an admin and upstream support for this command. |
| `lovelace/dashboards/list` | Command | Named dashboards, including their mode and URL path. |
| `lovelace/config` | Command | Read a complete dashboard; accepts `url_path` and optional `force`. |
| `lovelace/config/save` | Command | Replace a complete storage-mode dashboard; requires an admin. |
| `lovelace/subscribe` | Subscription | Live `lovelace_updated` events. |

`system_log/list` is a bounded, deduplicated warning/error history, not the full raw log. Raw streaming uses the command in Home Assistant's [system log stream implementation](https://github.com/home-assistant/core/blob/dev/homeassistant/components/system_log/stream.py); older instances that lack it return `unknown_command`. It does not require `fire_event`. The obsolete REST `/api/error_log` operation has been removed from this plugin's catalog because it returns 404 on current installations.

For warning/error event subscriptions, enable this in Home Assistant's `configuration.yaml` and restart Home Assistant:

```yaml
system_log:
  fire_event: true
```

See the [system log documentation](https://www.home-assistant.io/integrations/system_log/) and [WebSocket protocol](https://developers.home-assistant.io/docs/api/websocket/).

### Dedicated API calls

Use your Switchboard API token in the `Authorization: Bearer …` header. URL-encode the connection reference in these paths.

Read condensed logs with `POST /api/connections/{ref}/websocket/call`:

```json
{"operationId":"system_log/list","arguments":{}}
```

Use the same endpoint with `lovelace/dashboards/list` to discover dashboard URL paths, then load the dashboard:

```json
{"operationId":"lovelace/config","arguments":{"url_path":"my-home","force":true}}
```

The response contains the configuration in `result`. Preserve its existing fields, make the desired edits, and submit the **complete** configuration:

```json
{"operationId":"lovelace/config/save","arguments":{"url_path":"my-home","config":{"views":[{"title":"Home","cards":[{"type":"entities","entities":["light.kitchen"]}]}]}}}
```

Omit `url_path` or use `null` for the default dashboard. Named dashboards use their URL path, not the dashboard collection ID. YAML dashboards can be read but must be edited in their YAML files. A save replaces the entire configuration; it is not a patch. Read it again to verify the saved result. No writes are automatically retried.

Start a subscription with `POST /api/connections/{ref}/websocket/subscriptions`:

```json
{"operationId":"system_log/subscribe_raw","arguments":{"integration":"mqtt"}}
```

Omit `integration` to stream all raw logs. Alternatively use `system_log/subscribe` with empty arguments for warning/error events. The response contains a subscription `id`. Read events with `POST /api/connections/{ref}/websocket/subscriptions/{id}/read` and body `{"cursor":0,"waitMs":25000}`. Save `nextCursor` for subsequent reads and inspect `gap` and `status`; bounded buffers can drop older events. Delete `/api/connections/{ref}/websocket/subscriptions/{id}` to stop. Reads renew the five-minute subscription lease; reconnect explicitly after an interruption.

## Development

Use Node.js 24 or newer. Run `npm ci`, `npm run check`, and `npm test`. The plugin folder includes local type declarations, so development does not require a Switchboard checkout. Type imports are erased at runtime; shared helpers are provided by `ctx.require()` and the manifest declares compatible versions.

Keep `plugin.json` and `package.json` versions in sync. Commit version changes before tagging a release; `gh release create` does not bump versions. Switchboard follows the branch, tag or commit selected during installation.

## Releases

Release-please opens version and changelog pull requests from Conventional Commits. Merge the release PR to publish its tag and GitHub release. Plugin manifests are updated with their package versions. Family repositories maintain an independent version for each plugin.
