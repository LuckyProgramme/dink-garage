# DinkVision implementation scope — October 14, 2026

The consolidated implementation request supersedes the earlier read-only tenancy audit. Continue the existing Next.js, Supabase, browser recorder, Windows agent and Android application; preserve pre-existing changes and all recordings/queue data.

## Scope guard

- Complete safe rebranding; retain deployed identifiers needed to open existing credentials, local files, queues and migration history.
- Implement tenant membership, locations, court/device/session ownership, tenant-scoped administration, Google configuration and workers. Test two independent tenants and denied cross-tenant access.
- Verify wired capture, finalization, local persistence, playback timing and queue recovery. Fix reproduced problems, without changing wireless-specific behavior.
- Preserve the owner's explicit policy: valid recordings under 60 seconds are saved locally and do not upload or send replay email. A duration threshold must never be used to hide a finalization bug.
- No existing cutting workflow was found. With the optional clarification unanswered, implement the last minute of a finalized source as a separate local file and queue job. Preserve shorter sources unchanged and the original recording in all cases.
- Do not deploy schema changes, rotate credentials, send test emails, delete production data, or make billable infrastructure changes merely to satisfy a test. Use isolated fixtures and mocks; coordinate production rollout after the migration is reviewable.

## Stop condition

Implementation is complete when every executable critical acceptance check passes, regression checks remain green, and each remaining hardware or external-service dependency has an exact verification procedure and factual status. An absent physical tablet/camera, owner OAuth consent, production rollout or delivered test email cannot be marked PASS. A known unresolved software failure means NOT READY, even if builds pass. No claim of a fifteen-minute hardware recording without an actual fifteen-minute capture.

## Verified baseline

- 110 JavaScript/TypeScript/database/recorder tests passed before tenant implementation.
- TypeScript passed after the asset and bridge renames.
- Android debug APK, instrumented-test APK and Android lint built successfully.
- Existing architecture is single tenant with multiple courts/devices. Global administrator and service-role access, singleton venue/Google configuration, and global worker selection require isolation before shared customer hosting.
- No existing one-minute cut/export workflow was found; the camera setup test clip and sub-minute local-only policy are separate features.
- Physical Android/USB testing and delivered email verification remain outstanding.
