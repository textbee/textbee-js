# Releasing

`@textbee/sdk` publishes from CI on a `v*` tag push. Every release goes to two places: npm (the package) and GitHub Releases (the notes). Both are automated by `.github/workflows/publish.yaml`.

## One-time setup: trusted publishing

CI authenticates to npm with OIDC, so there is no long-lived npm token in this repo.

There is one catch. npm has no pending-publisher flow, unlike PyPI: a trusted publisher can only be configured on a package that already exists, so OIDC cannot perform a package's very first publish. That bootstrap has to happen once, by hand.

1. Create the `@textbee` org on npmjs.com, if it does not exist.
2. Publish once from a local machine, logged in as a member of the org:

   ```bash
   npm login
   pnpm run build
   npm publish --access public
   ```

   This first version has no provenance attestation, because provenance comes from CI. Every later release gets one.

3. On npmjs.com, open the package settings for `@textbee/sdk` and add a trusted publisher:

   | Field | Value |
   | --- | --- |
   | Provider | GitHub Actions |
   | Organization | `textbee` |
   | Repository | `textbee-js` |
   | Workflow filename | `publish.yaml` |
   | Allowed actions | `npm publish` |
   | Environment | leave empty |

4. Nothing else is needed. Do not add an `NPM_TOKEN` secret; the workflow does not read one.

## Cutting a release

1. Bump `version` in `package.json`.
2. Commit the bump on `main`.
3. Tag and push:

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

The workflow then typechecks, builds, tests, verifies the tag matches `package.json` (a mismatch fails the release rather than shipping the wrong version), publishes to npm with automatic provenance, and creates a GitHub Release with generated notes.

Release notes are worth keeping populated: Dependabot and Renovate surface them inside consumers' upgrade pull requests, which are otherwise empty.

## Requirements the workflow depends on

Trusted publishing needs Node 22.14 or later and npm 11.5.1 or later. Node 22 ships an older npm, so the workflow upgrades the CLI in a dedicated step. Changing either version is what breaks publishing first, so check them before blaming the OIDC config.
