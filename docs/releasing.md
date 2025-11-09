# Releasing

This project publishes to npm using GitHub Actions with trusted publishing. Tags drive releases.

## Prerequisites

- Trusted Publishing must be enabled for this package on npm (Settings → Automation → GitHub).
- `package.json` version must already be bumped to the release version.

## Steps

1. **Update version**
   - Edit `package.json` (and `package-lock.json` if present) with the new semantic version.
   - Commit the change: `git add package*.json && git commit -m "chore: release vX.Y.Z"`.

2. **Tag the release**
   - Create a matching tag locally: `git tag vX.Y.Z`.
   - Optionally annotate: `git tag -a vX.Y.Z -m "Release vX.Y.Z"`.

3. **Push branch and tag**
   - Ensure `main` contains the release commit (`git push origin main`).
   - Push the tag: `git push origin vX.Y.Z`.

4. **Wait for CI**
   - Pushing `v*` triggers `.github/workflows/publish.yml`, which:
     - installs dependencies, runs build/tests, and publishes via `npm publish` using OIDC.

5. **Verify**
   - Confirm the workflow succeeded (GitHub Actions tab).
   - Check `npm info <package-name>` for the new version.

## GitHub UI alternative

You can also create the tag when drafting a release in GitHub:
1. Open Releases → “Draft a new release”.
2. Enter `vX.Y.Z` in “Tag version”, target `main`, and choose “Create new tag”.
3. Publish the release; GitHub creates the tag and triggers the workflow.

## Notes

- The workflow requires npm 11.5.1+ and Node 20; it runs tests before publishing.
- If the workflow fails, fix the issue, delete the failed tag (`git push origin :refs/tags/vX.Y.Z`), re-tag, and push again once ready.
