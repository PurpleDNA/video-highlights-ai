/** WebCodecs cut: demux -> decode -> re-encode -> mux a window out of a local
 *  master .mp4.
 *
 *  Ported from spike/cut.js, a throwaway spike that cut a verified
 *  frame-accurate 60-second clip from a real 149 MB master in 12.3s, reading
 *  4.2 MB of it. Same demux/decode/encode/mux pipeline as the spike, with
 *  three changes:
 *   - reads come from a `File` (`file.slice(start, end).arrayBuffer()`)
 *     instead of HTTP `Range` requests — no network at all, since the master
 *     is a plain in-memory `File` for the session (see fsroot.js's module
 *     comment — it's never written to disk by this tool);
 *   - no DOM logging — an optional `onProgress(fraction)` callback stands in
 *     for it;
 *   - both spike findings below are kept, each with the comment explaining
 *     why it exists.
 */

import { loadMP4Box } from '../vendor/mp4box-esm.js';
import { Muxer, ArrayBufferTarget } from '../vendor/mp4-muxer.js';
import { cueAt, drawCue } from './subtitles.js';

const CHUNK = 1 << 21; // 2 MB

/** Read one byte range of the file. `fileStart` is what mp4box needs to
 *  place this buffer correctly within the whole (unread) file. */
async function readRange(file, start, end) {
  const buf = await file.slice(start, end).arrayBuffer();
  buf.fileStart = start;
  return buf;
}

/** The codec-private box (avcC / hvcC / vpcC / av1C) a WebCodecs decoder needs. */
function videoDescription(entry, MP4Box, DataStream) {
  const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
  if (!box) return null;
  // SPIKE FINDING: the UMD build exports `DataStream` as its own global, not
  // as a property of `MP4Box`. This is the first thing that fails without it.
  const DS = MP4Box.DataStream || DataStream;
  const s = new DS(undefined, 0, DS.BIG_ENDIAN);
  box.write(s);
  return new Uint8Array(s.buffer, 8); // strip the 8-byte box header
}

function audioDescription(entry) {
  // AudioSpecificConfig, buried in esds -> ES_Descriptor -> DecoderConfig -> DSI.
  try {
    const descs = entry.esds.esd.descs;
    for (const d of descs) {
      if (d.descs) {
        for (const dd of d.descs) if (dd.data) return new Uint8Array(dd.data);
      }
      if (d.data) return new Uint8Array(d.data);
    }
  } catch {
    return null;
  }
  return null;
}

/** Cut `[startSec, endSec)` out of `file` and return an mp4 Blob.
 *  `onProgress`, if given, is called with a fraction in [0, 1]; it never
 *  goes backwards. Reading is a small fraction of the file (the moov box
 *  plus the samples in the window), so most of the time — and most of the
 *  progress sweep — is the video/audio transcode, weighted accordingly. */
/** Archivo, the app's own sans, loaded into the worker so burned-in subtitles
 *  match the interface rather than falling back to whatever the platform
 *  calls sans-serif. Resolved once and reused; a failure here is cosmetic, so
 *  it degrades to the generic stack rather than failing the cut. */
let fontPromise = null;
function subtitleFont() {
  if (!fontPromise) {
    fontPromise = (async () => {
      const fallback = '"Segoe UI", Roboto, Helvetica, Arial, sans-serif';
      try {
        const face = new FontFace(
          'Archivo', `url(${new URL('../vendor/fonts/archivo-variable.woff2', import.meta.url)})`);
        await face.load();
        self.fonts.add(face);
        return `Archivo, ${fallback}`;
      } catch {
        return fallback;
      }
    })();
  }
  return fontPromise;
}

/** `subtitles` is the output of subtitles.js's cuesForWindow() — entries timed
 *  from the clip's own zero — or null/empty for a clean cut. */
export async function cut(file, startSec, endSec, onProgress, subtitles = null) {
  const size = file.size;
  const progress = makeProgress(onProgress);

  // Loaded here, at call time, not at module scope: see mp4box-esm.js's
  // module comment for why a top-level await here would silently break
  // cut-worker.js's message handling.
  const { MP4Box, DataStream } = await loadMP4Box();

  const mp4 = MP4Box.createFile();
  let info = null;
  mp4.onError = () => {};
  mp4.onReady = (i) => { info = i; };

  // --- moov ---------------------------------------------------------------
  let pos = 0;
  while (!info && pos < size) {
    const buf = await readRange(file, pos, Math.min(pos + CHUNK, size));
    const next = mp4.appendBuffer(buf);
    pos = (typeof next === 'number' && next > pos) ? next : pos + buf.byteLength;
  }
  if (!info) throw new Error('no moov found');
  progress(0.05);

  const vInfo = info.videoTracks[0];
  const aInfo = info.audioTracks[0];

  const vTrak = mp4.getTrackById(vInfo.id);
  const vEntry = vTrak.mdia.minf.stbl.stsd.entries[0];
  const vDesc = videoDescription(vEntry, MP4Box, DataStream);
  const aTrak = aInfo && mp4.getTrackById(aInfo.id);
  const aEntry = aTrak && aTrak.mdia.minf.stbl.stsd.entries[0];
  const aDesc = aEntry && audioDescription(aEntry);

  // --- sample extraction over the window ----------------------------------
  const vSamples = [], aSamples = [];
  mp4.onSamples = (id, _user, samples) => {
    const into = id === vInfo.id ? vSamples : aSamples;
    for (const s of samples) into.push(s);
  };
  mp4.setExtractionOptions(vInfo.id, null, { nbSamples: 200 });
  if (aInfo) mp4.setExtractionOptions(aInfo.id, null, { nbSamples: 400 });

  const seek = mp4.seek(startSec, true); // true = to the preceding sync sample
  mp4.start();

  const lastOf = (arr, tl) => (arr.length ? arr[arr.length - 1].cts / tl : -1);
  pos = seek.offset;
  // Sequential, not appendBuffer()'s "next position": with moov at the end
  // of the file that value jumps to EOF after the first chunk — see the same
  // loop in audio.js for the measured failure.
  while (pos < size) {
    const end = Math.min(pos + CHUNK, size);
    mp4.appendBuffer(await readRange(file, pos, end));
    pos = end;
    const vDone = lastOf(vSamples, vInfo.timescale) >= endSec;
    const aDone = !aInfo || lastOf(aSamples, aInfo.timescale) >= endSec;
    if (vDone && aDone) break;
  }
  mp4.stop();
  mp4.flush();
  progress(0.15);

  // --- probe the real audio shape -----------------------------------------
  // SPIKE FINDING: the container's sample_rate is the AAC-LC core rate
  // (22050 Hz in these masters, HE-AAC / mp4a.40.5); SBR doubles it on
  // decode, so the decoder ends up emitting 44100 Hz. The muxer's audio
  // track and the encoder both need the *decoded* rate/channel count — only
  // a decoded frame knows it. Configuring either from the container value
  // throws "Unsupported sample rate".
  let aShape = null;
  if (aInfo && aDesc && aSamples.length) {
    aShape = await new Promise((resolve) => {
      const probe = new AudioDecoder({
        output: (d) => {
          if (!aShape) resolve({ sampleRate: d.sampleRate, channels: d.numberOfChannels });
          d.close();
        },
        // Closed here too, not just on the success path below: an
        // unconfigurable/undecodable probe used to leave this AudioDecoder
        // open forever. Every verification run cut exactly one clip, so a
        // leaked codec instance never mattered there — export.js runs many
        // cuts back-to-back in one long-lived worker, and Chrome caps
        // concurrent hardware codec instances, so a leak here could starve
        // every cut after it in the same export.
        error: () => { try { probe.close(); } catch { /* already closed */ } resolve(null); },
      });
      probe.configure({
        codec: aInfo.codec,
        sampleRate: aInfo.audio.sample_rate,
        numberOfChannels: aInfo.audio.channel_count,
        description: aDesc,
      });
      const s = aSamples[0];
      probe.decode(new EncodedAudioChunk({
        type: 'key',
        timestamp: (s.cts / s.timescale) * 1e6,
        duration: (s.duration / s.timescale) * 1e6,
        data: s.data,
      }));
      probe.flush().then(() => probe.close()).catch(() => {});
    });
  }

  // --- transcode ----------------------------------------------------------
  const startUs = startSec * 1e6, endUs = endSec * 1e6;
  const windowUs = endUs - startUs;
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: vInfo.video.width, height: vInfo.video.height },
    ...(aShape ? {
      audio: {
        codec: 'aac',
        sampleRate: aShape.sampleRate,
        numberOfChannels: aShape.channels,
      },
    } : {}),
    firstTimestampBehavior: 'offset',
    fastStart: 'in-memory',
  });

  // Derived from the source rather than fixed: the verified master (the
  // spike's 12.3s/4.2MB measurement, and the one PSNR ever ran against) is
  // 640x360/25fps, and a flat 2 Mbps/25fps happened to be right for exactly
  // that master. A 1080p source encoded at the same flat 2 Mbps would look
  // visibly worse than its own source. Framerate comes from the track's own
  // sample count and duration (both in its own timescale, per mp4box's
  // getTrackInfo — see the movie_duration/duration/nb_samples fields read
  // above), falling back to 25 only if a track somehow reports zero of
  // either. Bitrate scales linearly with pixel count against the verified
  // 640x360 master's 2 Mbps, so a 1080p master (9x the pixels) lands near
  // 18 Mbps rather than being starved at the 360p number.
  const BASELINE_PIXELS = 640 * 360;
  const BASELINE_BITRATE = 2_000_000;
  const vFramerate = vInfo.nb_samples && vInfo.duration
    ? Math.round((vInfo.nb_samples * vInfo.timescale) / vInfo.duration)
    : 25;
  const vBitrate = Math.round(
    BASELINE_BITRATE * (vInfo.video.width * vInfo.video.height) / BASELINE_PIXELS,
  );

  let firstFrame = true;
  let vEncoder = null;
  let vDecoder = null;
  let aEncoder = null;
  let aDecoder = null;

  // Every codec object opened below is closed in this `finally`, success or
  // failure: `.close()` was previously never called on any of them, and
  // export.js runs many cuts back-to-back in one long-lived worker (unlike
  // every verification run so far, which cut exactly one clip and let the
  // worker die right after). Chrome caps concurrent hardware codec
  // instances, so a leaked encoder/decoder here doesn't just cost memory —
  // it can make a later clip in the same export fail, and export.js
  // swallows a per-clip failure into `skipped` rather than surfacing it, so
  // that failure could go unnoticed in a large export.
  try {
    vEncoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: () => {},
    });
    vEncoder.configure({
      codec: 'avc1.42001f',
      width: vInfo.video.width,
      height: vInfo.video.height,
      bitrate: vBitrate,
      framerate: vFramerate,
      avc: { format: 'avc' },
    });

    // Subtitles are burned in rather than carried as a track: these clips get
    // re-uploaded to LinkedIn, X and Instagram, none of which keep a sidecar,
    // and they autoplay muted. Drawing costs one canvas composite per frame,
    // which roughly triples the encode — acceptable for a monthly job.
    const vw = vInfo.video.width;
    const vh = vInfo.video.height;
    const canvas = subtitles && subtitles.length ? new OffscreenCanvas(vw, vh) : null;
    const ctx = canvas ? canvas.getContext('2d', { alpha: false }) : null;
    const fontFamily = await subtitleFont();

    // Video transcode fills the [0.15, 0.85] slice of progress: it's the
    // bulk of the wall-clock time, and its frame timestamps sweep the window.
    vDecoder = new VideoDecoder({
      output: (frame) => {
        if (frame.timestamp < startUs || frame.timestamp >= endUs) {
          frame.close();
          return;
        }
        progress(0.15 + 0.7 * clamp01((frame.timestamp - startUs) / windowUs));
        const ts = frame.timestamp - startUs;

        let outgoing;
        if (ctx) {
          ctx.drawImage(frame, 0, 0, vw, vh);
          const cue = cueAt(subtitles, ts / 1e6);
          if (cue) drawCue(ctx, cue.text, vw, vh, fontFamily);
          // Timestamp and duration have to be carried over by hand: a frame
          // built from a canvas has no timing of its own, and dropping the
          // duration leaves the muxer guessing at the last frame's length.
          outgoing = new VideoFrame(canvas, {
            timestamp: ts,
            ...(frame.duration == null ? {} : { duration: frame.duration }),
          });
        } else {
          outgoing = new VideoFrame(frame, { timestamp: ts });
        }

        vEncoder.encode(outgoing, { keyFrame: firstFrame });
        firstFrame = false;
        outgoing.close();
        frame.close();
      },
      error: () => {},
    });
    vDecoder.configure({ codec: vInfo.codec, description: vDesc });

    for (const s of vSamples) {
      const ts = (s.cts / s.timescale) * 1e6;
      if (ts >= endUs + 1e6) break;
      vDecoder.decode(new EncodedVideoChunk({
        type: s.is_sync ? 'key' : 'delta',
        timestamp: ts,
        duration: (s.duration / s.timescale) * 1e6,
        data: s.data,
      }));
    }
    await vDecoder.flush();
    await vEncoder.flush();
    progress(0.85);

    // --- audio --------------------------------------------------------------
    if (aShape) {
      aEncoder = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: () => {},
      });
      // Configure both the encoder and (above) the muxer's audio track from
      // the decoded shape, not the container's — see the probe comment
      // above. Always encode to plain AAC-LC (`mp4a.40.2`), which is what
      // encoders offer; the source (mp4a.40.5, HE-AAC) is only ever decoded,
      // never re-encoded as-is.
      aEncoder.configure({
        codec: 'mp4a.40.2',
        sampleRate: aShape.sampleRate,
        numberOfChannels: aShape.channels,
        bitrate: 128_000,
      });
      aDecoder = new AudioDecoder({
        output: (data) => {
          if (data.timestamp < startUs || data.timestamp >= endUs) { data.close(); return; }
          progress(0.85 + 0.14 * clamp01((data.timestamp - startUs) / windowUs));
          // AudioData has no copy-constructor with a new timestamp; rebuild it.
          const frames = data.numberOfFrames, ch = data.numberOfChannels;
          const buf = new Float32Array(frames * ch);
          for (let c = 0; c < ch; c++) {
            data.copyTo(buf.subarray(c * frames, (c + 1) * frames),
                        { planeIndex: c, format: 'f32-planar' });
          }
          const shifted = new AudioData({
            format: 'f32-planar',
            sampleRate: data.sampleRate,
            numberOfFrames: frames,
            numberOfChannels: ch,
            timestamp: data.timestamp - startUs,
            data: buf,
          });
          aEncoder.encode(shifted);
          shifted.close();
          data.close();
        },
        error: () => {},
      });
      // Decode as whatever the source actually is (these masters are
      // mp4a.40.5, HE-AAC); see above for why the re-encode is always AAC-LC.
      aDecoder.configure({
        codec: aInfo.codec,
        sampleRate: aInfo.audio.sample_rate,
        numberOfChannels: aInfo.audio.channel_count,
        description: aDesc,
      });
      for (const s of aSamples) {
        const ts = (s.cts / s.timescale) * 1e6;
        if (ts >= endUs) break;
        aDecoder.decode(new EncodedAudioChunk({
          type: 'key',
          timestamp: ts,
          duration: (s.duration / s.timescale) * 1e6,
          data: s.data,
        }));
      }
      await aDecoder.flush();
      await aEncoder.flush();
    }
  } finally {
    for (const codec of [vEncoder, vDecoder, aEncoder, aDecoder]) {
      if (!codec) continue;
      try { codec.close(); } catch { /* already closed by its own error path */ }
    }
  }

  muxer.finalize();
  progress(1);
  return new Blob([muxer.target.buffer], { type: 'video/mp4' });
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Wraps an optional onProgress so callers never see it go backwards or
 *  outside [0, 1], and is a safe no-op when onProgress isn't given. */
function makeProgress(onProgress) {
  if (!onProgress) return () => {};
  let last = 0;
  return (fraction) => {
    const clamped = clamp01(fraction);
    if (clamped > last) {
      last = clamped;
      onProgress(clamped);
    }
  };
}
