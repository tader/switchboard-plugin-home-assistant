# Home Assistant

Home Assistant instances, with browser sign-in or a long-lived access token.

Maintained independently from [Switchboard](https://github.com/tader/switchboard).

## Installation

Open **Plugins → Community** in Switchboard and install **Home Assistant**. Alternatively use **Install from GitHub** with repository `tader/switchboard-plugin-home-assistant` and path `plugins/home-assistant`. Review the dependency preview and apply it.

Dependencies: `oauth2` (^1.0.0), `api-key` (^1.0.0). Missing external dependencies are resolved through the live community catalog; OAuth and API Keys are built into Switchboard.

## Existing installations

Install this repository before upgrading a Switchboard instance that bundles `home-assistant`. The plugin ID, service IDs, authentication methods, settings and persistent data paths are preserved. Installed plugins replace the built-in copy. Existing connections and saved calls continue to work; keep the instance data directory and encryption key.

## Development

Use Node.js 24 or newer. Run `npm ci` and `npm run check`. The plugin folder includes local type declarations, so development does not require a Switchboard checkout. Type imports are erased at runtime; shared helpers are provided by `ctx.require()` and the manifest declares compatible versions.

Keep `plugin.json` and `package.json` versions in sync. Commit version changes before tagging a release; `gh release create` does not bump versions. Switchboard follows the branch, tag or commit selected during installation.

## Releases

Release-please opens version and changelog pull requests from Conventional Commits. Merge the release PR to publish its tag and GitHub release. Plugin manifests are updated with their package versions. Family repositories maintain an independent version for each plugin.
