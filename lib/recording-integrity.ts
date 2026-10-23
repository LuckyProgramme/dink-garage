// Inspect MP4 timing tables without loading the video payload into memory.
// Both normal MP4 (stts) and MediaRecorder's fragmented MP4 (tfdt/trun) are supported.
export class RecordingIntegrityError extends Error {}
type Box = { type: string; start: number; end: number };
type Track = { id: number; kind: string; scale: number; duration: number; start?: number; end?: number; defaultDuration: number; samples: number };
function fail(message: string): never { throw new RecordingIntegrityError(message + " The video remains on this device."); }
const u32 = (v: DataView, n: number) => v.getUint32(n);
function u64(v: DataView, n: number) {
  const value = Number(v.getBigUint64(n));
  if (!Number.isSafeInteger(value)) fail("Video timing exceeds supported limits.");
  return value;
}
function boxes(v: DataView, start = 0, end = v.byteLength): Box[] {
  const result: Box[] = [];
  while (start < end) {
    if (end - start < 8) fail("Video metadata is incomplete.");
    let size = u32(v, start), header = 8;
    const type = String.fromCharCode(...new Uint8Array(v.buffer, v.byteOffset + start + 4, 4));
    if (size === 1) { size = u64(v, start + 8); header = 16; }
    if (size === 0) size = end - start;
    if (size < header || start + size > end) fail("Video metadata is incomplete.");
    result.push({ type, start: start + header, end: start + size });
    start += size;
  }
  return result;
}
function child(v: DataView, b: Box, name: string) {
  return boxes(v, b.start, b.end).find(x => x.type === name);
}
function checkDuration(actual: number, expected: number, label: string) {
  const tolerance = Math.max(1500, Math.min(3000, expected * .02));
  if (!Number.isFinite(actual) || actual <= 0 || (expected > 0 && Math.abs(actual - expected) > tolerance))
    fail(`${label} timing does not match the recording (${Math.round(actual)}ms media, ${Math.round(expected)}ms capture).`);
}
export async function inspectRecording(blob: Blob, expectedMs?: number, expectAudio = false) {
  const tracks = new Map<number, Track>();
  let offset = 0, mediaBytes = 0;
  try {
    while (offset < blob.size) {
      if (blob.size - offset < 8) fail("Video file is incomplete.");
      const head = new DataView(await blob.slice(offset, offset + 16).arrayBuffer());
      let size = u32(head, 0), header = 8;
      const type = String.fromCharCode(...new Uint8Array(head.buffer, 4, 4));
      if (size === 1) { size = u64(head, 8); header = 16; }
      if (!size) size = blob.size - offset;
      if (size < header || offset + size > blob.size) fail("Video file is incomplete.");
      if (type === "mdat") mediaBytes += size - header;
      if (type === "moov" || type === "moof") {
        if (size > 16 * 1024 * 1024) fail("Video metadata is too large to validate safely.");
        const v = new DataView(await blob.slice(offset + header, offset + size).arrayBuffer());
        if (type === "moov") {
          for (const box of boxes(v).filter(b => b.type === "trak")) {
            const tkhd = child(v, box, "tkhd"), mdia = child(v, box, "mdia");
            if (!tkhd || !mdia) fail("Video track metadata is missing.");
            const mdhd = child(v, mdia, "mdhd"), hdlr = child(v, mdia, "hdlr");
            if (!mdhd || !hdlr) fail("Video track timing is missing.");
            const id = u32(v, tkhd.start + (v.getUint8(tkhd.start) === 1 ? 20 : 12));
            const p = mdhd.start + (v.getUint8(mdhd.start) === 1 ? 20 : 12);
            const scale = u32(v, p);
            const kind = String.fromCharCode(...new Uint8Array(v.buffer, hdlr.start + 8, 4));
            const track: Track = { id, kind, scale, duration: 0, defaultDuration: 0, samples: 0 };
            if (!scale) fail("Video track clock is invalid.");
            const minf = child(v, mdia, "minf"), stbl = minf && child(v, minf, "stbl"), stts = stbl && child(v, stbl, "stts");
            if (stts) {
              const count = u32(v, stts.start + 4);
              if (stts.start + 8 + count * 8 > stts.end) fail("Video timing table is truncated.");
              for (let i = 0; i < count; i++) {
                const n = u32(v, stts.start + 8 + i * 8), delta = u32(v, stts.start + 12 + i * 8);
                if (n && delta / scale > 3) fail("Video contains a timing gap exceeding 3 seconds.");
                track.duration += n * delta; track.samples += n;
              }
            }
            tracks.set(id, track);
          }
          const mvex = boxes(v).find(b => b.type === "mvex");
          if (mvex) for (const trex of boxes(v, mvex.start, mvex.end).filter(b => b.type === "trex")) {
            const track = tracks.get(u32(v, trex.start + 4));
            if (track) track.defaultDuration = u32(v, trex.start + 12);
          }
        } else {
          for (const traf of boxes(v).filter(b => b.type === "traf")) {
            const tfhd = child(v, traf, "tfhd"), tfdt = child(v, traf, "tfdt");
            if (!tfhd || !tfdt) fail("Video fragment clock is missing.");
            const track = tracks.get(u32(v, tfhd.start + 4));
            if (!track) fail("Video fragment has no matching track.");
            const flags = u32(v, tfhd.start) & 0xffffff;
            let p = tfhd.start + 8 + (flags & 1 ? 8 : 0) + (flags & 2 ? 4 : 0);
            const defaultDuration = flags & 8 ? u32(v, p) : track.defaultDuration;
            let time = v.getUint8(tfdt.start) === 1 ? u64(v, tfdt.start + 4) : u32(v, tfdt.start + 4);
            // Browser muxers can overlap the estimated last sample duration by
            // a few milliseconds when finalizing the next fragment.
            if (track.end !== undefined && (time + track.scale * .05 < track.end || (time - track.end) / track.scale > 3))
              fail("Video fragments contain a clock reset or excessive gap.");
            track.start ??= time;
            for (const run of boxes(v, traf.start, traf.end).filter(b => b.type === "trun")) {
              const flags = u32(v, run.start) & 0xffffff, count = u32(v, run.start + 4);
              p = run.start + 8 + (flags & 1 ? 4 : 0) + (flags & 4 ? 4 : 0);
              const stride = (flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0) + (flags & 0x400 ? 4 : 0) + (flags & 0x800 ? 4 : 0);
              if (count > 1_000_000 || p + stride * count > run.end) fail("Video fragment is invalid.");
              for (let i = 0; i < count; i++) {
                const delta = flags & 0x100 ? u32(v, p) : defaultDuration;
                // Equal adjacent timestamps produce explicit zero-duration samples in
                // browser MP4 output. Keep the source clock; never invent an FPS.
                // An absent/default zero duration is different: there is no clock.
                if ((!delta && !(flags & 0x100)) || delta / track.scale > 3)
                  fail(`${track.kind === "soun" ? "Audio" : "Video"} sample clock is invalid or stalled (track ${track.id}, sample ${track.samples + i + 1}, duration ${delta}/${track.scale}).`);
                track.duration += delta;
                time += delta; p += stride;
              }
              track.samples += count;
            }
            track.end = time;
          }
        }
      }
      offset += size;
    }
    const video = [...tracks.values()].find(t => t.kind === "vide" && t.samples > 0);
    const audio = [...tracks.values()].find(t => t.kind === "soun" && t.samples > 0);
    if (!mediaBytes || !video || video.duration <= 0) fail("No complete video track was saved.");
    const duration = (t: Track) => (t.end !== undefined ? t.end - (t.start || 0) : t.duration) / t.scale * 1000;
    const videoMs = duration(video);
    checkDuration(videoMs, expectedMs || 0, "Video");
    if (expectAudio && !audio) fail("The expected audio track is missing.");
    if (audio) {
      if (audio.duration <= 0) fail("Audio sample clock does not advance.");
      checkDuration(duration(audio), videoMs, "Audio/video");
      if (Math.abs((audio.start || 0) / audio.scale - (video.start || 0) / video.scale) > 1.5)
        fail("Audio/video starting times do not match.");
    }
    return { videoMs, audioMs: audio ? duration(audio) : undefined, videoSamples: video.samples };
  } catch (error) {
    if (error instanceof RecordingIntegrityError) throw error;
    return fail("Video metadata could not be validated.");
  }
}
