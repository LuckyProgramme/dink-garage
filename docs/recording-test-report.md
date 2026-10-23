# Recording reliability test report

Date: October 13, 2026. Workspace: `D:\Company Projects\picklecamera`.

## Results

- `npm test`: **109 passed, 0 failed**, including 34 added regression tests.
- `npm run build`: passed, including TypeScript compilation.
- Android debug APK and instrumentation APK: compiled successfully.
- Android lint: no errors. Remaining warnings concern WebView JavaScript review,
  backup configuration, localization/assets, storage allocation suggestions, and
  the Gradle wrapper version; this is not a warning-free build.
- No physical Android device or configured emulator was available. Android
  instrumentation tests were compiled, not executed.

The tests use isolated IndexedDB, isolated PostgreSQL-compatible databases,
simulated browser/camera and network failures, and real MP4/FFmpeg fixtures.
They do not establish hardware reliability or verify live Google delivery.

## Reproduced failures and fixes

1. Concurrent local metadata changes could overwrite `uploaded` with an older
   `uploading` state. Metadata merges now run in one IndexedDB transaction.
2. Encoder errors before the first frame could reject an unobserved promise.
   Both startup promises are observed immediately and cleanup settles pending
   startup waits, preventing a permanently busy start action.
3. Closing the recording page during camera permission, a pending start request,
   or countdown could still start recording afterward. Startup now checks
   cancellation across those waits, closes late camera resources, and reports
   failure for a server session already created. Duplicate starts are guarded
   before camera acquisition.
4. An unfinished capture from a closed browser could remain `saved_locally`
   indefinitely. Recovery marks it interrupted/failed while holding the capture
   lock, retains its bytes, and reports the old session failure. An active
   recording in another tab is protected by that same lock.
5. HTML, empty, or null API responses exposed raw JSON parsing errors. They now
   produce an actionable tablet connection error and enter bounded retry.
6. A synchronous storage-full exception leaked an IndexedDB connection. Failed
   transaction setup now aborts and closes the connection.
7. Android lint identified camera/microphone foreground flags being used behind
   an API 29 guard. Those flags now require API 30; older devices retain the
   existing foreground-service path.

## Coverage

| Area | Verified automatically |
| --- | --- |
| Startup | Permission denied, missing microphone, encoder construction/start exceptions, encoder error before first frame, no start event, empty capture, late permission response |
| Cancellation | Leaving during permission/start/countdown, concurrent starts, repeated stops, missing stop event, stop throwing, camera track ending |
| Local storage | Concurrent completion/dismissal updates, quota failure and resource release, saved chunks retained after failure, record again after recovery |
| Integrity | Normal and fragmented MP4, 60 truncation/header corruption variants, timing drift/gaps, missing audio, zero clocks, duplicate movie headers |
| Duration policy | Short clips stay local; SQL boundary cases include 59,999 ms and 60,000 ms; short replay emails are held |
| Upload | Timeout, network loss, malformed response, missing/negative/fractional/oversized offsets, repeated expiry, cancellation, missing final confirmation |
| Retry/restart | Eight-attempt budget, exponential backoff, persisted retries, stale retry requests, abandoned capture recovery, lost completion acknowledgement |
| Concurrency | 24 queued recordings, eight overlapping workers, two devices, no duplicate processing; delayed jobs do not block eligible clips |
| Player state | Active recording takes precedence, selected result stays selected, leaving a result does not restore older failures |
| Backend | Enrollment/ownership, database permissions, queue leases/expiry, Drive/email/retention regression tests |

## Physical and live checks still required

Use a test court/account and keep the local backup available for playback checks.

1. On every supported Android/browser combination, repeatedly record and stop
   0.5-, 1-, 15-, and 59-second clips; immediately start another match each time.
   Confirm the first start succeeds and results do not jump to welcome.
2. Record at least 60 seconds and a full match. Play and seek through the local
   backup and uploaded replay, checking final frames, audio, duration and sync.
3. Remove/reconnect the USB camera during permission, countdown, recording and
   finalization. Repeat after revoking/restoring camera and microphone access.
4. Turn Wi-Fi off during upload and after its final response; queue multiple
   recordings, restart the app/browser and reconnect. Confirm one Drive file
   and one intended email per eligible recording, and neither for short clips.
5. Exercise screen lock, app switching, rotation/flips, battery restrictions,
   long matches, thermal load and actual low-storage conditions.
6. Repeat on two physical devices simultaneously. Verify independent queues,
   clean start/stop controls, usable notification placement and accessible
   controls at each supported screen size.

These checks cannot be replaced by mocked events or successful APK compilation.
The fixes are local; this test pass did not deploy the web application.
