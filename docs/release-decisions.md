# Release decisions

Last reviewed: 2026-08-30

## Extension identity

Decision: preserve `tab-leak-guard@local.invalid`.

The ID is unconventional, but it is the identity of signed 0.1.0. Changing it would create a different Firefox add-on and break seamless continuity. Every version check, manifest, AMO listing, and update rehearsal must use this exact value. A future migration would require a separately approved product decision and explicit user migration.

## Distribution and updates

Decision: use listed AMO as the eventual consumer update channel; use unlisted signed builds only for internal dogfood.

The installed unlisted 0.1.0 manifest has no `update_url`, so another unlisted build will not automatically reach it. Do not add a self-hosted update URL while pursuing listed AMO distribution. Before 0.1.1 is described as generally available, prove an installed signed 0.1.0 profile discovers and installs the higher listed version. Until then, clearly label manual installation instructions.

## Firefox compatibility

Decision: retain `strict_min_version` 142 for notify/manual use. Native `documentId` is feature-detected; automatic recovery remains quarantined regardless of version. If automatic recovery is ever enabled, require native document identity and document the resulting Firefox tier or raise the minimum version after compatibility verification.

## Recovery policy

Decision: 0.1.1 is notify/manual only. Automatic recovery is compile-time disabled and may return only after all safety, beta, and rollback gates pass. There is no remote kill switch; emergency safety changes are delivered through a signed update.

## Artifact policy

Only the production unsigned ZIP is a signing candidate. The review ZIP contains source maps and is never distributed to users. The source ZIP, content manifest, SBOM, checksums, release notes, signed XPI returned by AMO, and AMO validation report are retained together. CI never receives signing credentials.
