# Release checklist

How to release `cloud-tailscale` from
[`Dasannn/Cloud-Tailscale`](https://github.com/Dasannn/Cloud-Tailscale).
This mirrors Agent-Bridge's owner-approved, staged npm publishing flow.
Task 3.1 prepares the release; the lead and owner perform the first publish
in task 3.2.

## Before releasing

- [ ] CI is green on the release commit with Node.js 20 and 22.
- [ ] The implementation tasks for this version are complete and reviewed.
- [ ] `package.json` and `package-lock.json` have the intended version.
      The first release is `0.1.0`.
- [ ] The package's public repository URL is
      `git+https://github.com/Dasannn/Cloud-Tailscale.git`, matching the
      repository's spelling and case for npm provenance.
- [ ] `CHANGELOG.md` has an entry for that version.
- [ ] Lint, typecheck, tests, and build pass, and the package test confirms
      that only runtime modules, the skill, README, license, and package
      metadata ship.
- [ ] Pack the release and install it in a temporary prefix. Confirm that
      `cts --version`, `cts --help`, and `cts skill --print` work without
      credentials or a running Tailscale daemon.
- [ ] The reviewed release commit is merged to `main`.

From the repository root, use `/tmp` for npm's cache and the tarball smoke
check so no test installation or tarball is left in the repository:

```bash
export npm_config_cache=/tmp/npm-cache
npm ci
npm run lint
npm run typecheck
npm test
npm run build

release_dir=$(mktemp -d /tmp/cloud-tailscale-release.XXXXXX)
npm pack --pack-destination "$release_dir"
# Replace 0.1.0 below with the version being released.
npm install --prefix "$release_dir/install" "$release_dir/cloud-tailscale-0.1.0.tgz"
"$release_dir/install/node_modules/.bin/cts" --version
"$release_dir/install/node_modules/.bin/cts" --help
"$release_dir/install/node_modules/.bin/cts" skill --print
rm -rf "$release_dir"
```

The packed CLI is self-contained except for its declared runtime
dependencies. Do not use a real auth key for this smoke check. Live tailnet
checks are separate, and their results belong in `docs/decisions/`.

## First manual publish: lead and owner

The first manual publish creates the npm package so the owner can configure
its trusted publisher. This is task 3.2, performed only with the owner's
approval, from the clean, reviewed release commit after the checks above.

The owner signs in from the lead's session using the browser flow:

```bash
npm login --auth-type=web
```

The lead then publishes the initial release:

```bash
npm publish --access public
```

Do not create an npm automation token or put npm credentials in the
repository or workflow. The first manual publish does not use the tag
workflow's OIDC identity. Do not push `v0.1.0` expecting the workflow to
publish the already published version again; npm versions are immutable.
Use the tag flow for subsequent unpublished versions after configuring the
trusted publisher.

## One-time trusted publisher setup: owner

After the first manual publish, open
[`cloud-tailscale` on npm](https://www.npmjs.com/package/cloud-tailscale)
→ Settings → Trusted Publisher → GitHub Actions:

| Field | Value |
| --- | --- |
| Organization or user | `Dasannn` |
| Repository | `Cloud-Tailscale` |
| Workflow filename | `publish.yml` |
| Environment | Leave empty. |

Allow `npm stage publish` only; leave direct `npm publish` and dist-tag
management permissions disabled. The workflow stages releases for the
owner's approval, as Agent-Bridge does. Enable two-factor authentication on
the owner's npm account for approval.

No npm token or repository secret is needed. The workflow runs on a
GitHub-hosted Linux runner with Node.js 22 (22.14.0 or later), upgrades npm
to 11.15.0 or later within major 11, and grants `id-token: write` alongside
`contents: read`. npm detects OIDC and generates provenance for this public
package from its public repository. See
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
[provenance requirements](https://docs.npmjs.com/generating-provenance-statements/).

Do not set `registry-url` in `actions/setup-node`: Agent-Bridge found that
the generated `.npmrc` can cause npm to use a placeholder token instead of
OIDC. Do not add `NODE_AUTH_TOKEN` or `NPM_TOKEN` to this workflow. After the
first trusted release succeeds, revoke any old publish token and remove its
repository secret if one exists. The owner can then require 2FA and
disallow token publishing in the package's publishing access settings.

## Subsequent releases: tag-based flow

Update the version in `package.json` and `package-lock.json`, update the
changelog, complete the checklist, and merge the work to `main`. For example,
for the next patch release, push a tag on that reviewed `main` commit:

```bash
git tag v0.1.1
git push origin v0.1.1
```

The **Publish** workflow (`.github/workflows/publish.yml`):

1. Installs dependencies and runs lint, typecheck, tests, and build.
2. Checks that the tag is exactly `v` followed by `package.json`'s version.
3. Runs `npm stage publish --access public` using trusted publishing and
   automatic provenance.

The version is not publicly installable until the owner approves it. The
stage reserves that version number. The owner uses Node.js 22.14.0 or later
and npm 11.15.0 or later on their own computer:

```bash
npm install -g npm@^11.15.0
npm login --auth-type=web
npm stage list cloud-tailscale
npm stage approve <stage-id>
```

Approval requires the owner's 2FA. The stage ID also appears in the workflow
log. OIDC cannot approve a release. To reject it, use
`npm stage reject <stage-id>`. See [npm staged publishing](https://docs.npmjs.com/cli/v11/commands/npm-stage/).

A GitHub release can also create a tag on the reviewed `main` commit. Copy
the version's changelog entry into the release notes. A tag/version mismatch
fails before staging; correct the release metadata through review before
trying again.

## After publishing

- [ ] Confirm the npm version and, for trusted releases, its provenance.
- [ ] In a fresh Claude Code on the web session, follow only the README:
      `npm install -g cloud-tailscale && cts setup || true`. Confirm `cts`
      is on PATH, the skill loads, and the node is ephemeral.
- [ ] Run `cts status`, an SSH command against the owner's chosen test
      device, and `cts down`; verify immediate removal from the tailnet.
- [ ] Check that no credentials appeared in output, logs, process arguments,
      or files outside the private runtime home. Never copy secrets into a
      verification record.
- [ ] Record live results in a decision record. Codex Cloud verification
      remains Phase 4: use a fresh non-root task with a read-only home,
      agent internet access, and supported secret injection.
