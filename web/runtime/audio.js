/** WebCodecs audio extraction: demux -> decode -> re-encode -> mux an
 *  audio-only .mp4 out of a local master, small enough to upload to
 *  AssemblyAI. Measured against a real 149 MB, ~84-minute master: a 61 MB
 *  mono AAC output in 62s wall clock (see AUDIO_BITRATE below for why this
 *  is 96 kbps rather than the ~48 kbps originally targeted — still well
 *  under half the master's size).
 *
 *  Reuses the exact demux/decode machinery cut.js already proves works —
 *  `loadMP4Box()`, `DataStream`, the sample-extraction loop, `AudioDecoder` —
 *  the difference is this reads the *whole* file's audio track (not a
 *  window) and never touches video at all: no video track is demuxed beyond
 *  what mp4box needs to parse the moov box, and the muxer is constructed
 *  with no `video` key, per mp4-muxer's audio-only contract.
 *
 *  Both spike findings cut.js documents apply identically here and are kept
 *  with the same comments at the point each is worked around:
 *   - `DataStream` is a separate global, not `MP4Box.DataStream`.
 *   - the container's audio sample rate lies: these masters are HE-AAC
 *     (mp4a.40.5), mp4box reports 22050 Hz, SBR doubles it on decode, and
 *     the decoder actually emits 44100 Hz — only a decoded AudioData frame
 *     knows the real rate.
 *
 *  Every codec object opened here is closed in a `finally`, for the same
 *  reason cut.js gives: a leaked codec doesn't just cost memory, it can
 *  starve or fail whatever runs next in the same worker.
 */

import { loadMP4Box } from '../vendor/mp4box-esm.js';
import { Muxer, ArrayBufferTarget } from '../vendor/mp4-muxer.js';

const CHUNK = 1 << 21; // 2 MB

// Speech-appropriate, mono. The originally-targeted ~48 kbps turned out not
// to be reachable: Chrome's AAC (mp4a.40.2) AudioEncoder only accepts one of
// a fixed set of bitrates — 96000, 128000, 160000, 192000 — and rejects
// anything else with "Unsupported bitrate" (measured directly: configuring
// at 48_000 closes the encoder on its first encode() call, so every frame
// after the first silently fails once the swallowed error handler below
// closes it). 96 kbps is the lowest of those four and is what the module
// comment's real-master measurement above used.
const AUDIO_BITRATE = 96_000;

/** Read one byte range of the file. `fileStart` is what mp4box needs to
 *  place this buffer correctly within the whole (unread) file. Identical to
 *  cut.js's readRange(). */
async function readRange(file, start, end) {
  const buf = await file.slice(start, end).arrayBuffer();
  buf.fileStart = start;
  return buf;
}

/** AudioSpecificConfig, buried in esds -> ES_Descriptor -> DecoderConfig ->
 *  DSI. Identical to cut.js's audioDescription(). */
function audioDescription(entry) {
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

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

/** Downmix one decoded AudioData frame to a single channel by averaging all
 *  input channels (a no-op average when there's only one). AudioEncoder
 *  requires its input's channel count to match the configured one exactly,
 *  so this has to happen before encode(), not left to the encoder. */
function downmixToMono(data) {
  const frames = data.numberOfFrames;
  const channels = data.numberOfChannels;
  const mono = new Float32Array(frames);
  const tmp = new Float32Array(frames);
  for (let c = 0; c < channels; c++) {
    data.copyTo(tmp, { planeIndex: c, format: 'f32-planar' });
    for (let i = 0; i < frames; i++) mono[i] += tmp[i] / channels;
  }
  return new AudioData({
    format: 'f32-planar',
    sampleRate: data.sampleRate,
    numberOfFrames: frames,
    numberOfChannels: 1,
    timestamp: data.timestamp,
    data: mono,
  });
}

/** Extract and re-encode the audio track of `file` (a local media `File`,
 *  read via `.slice()` — no network) as a small mono AAC .mp4 Blob.
 *  `onProgress`, if given, is called with a fraction in [0, 1]; it never
 *  goes backwards. `signal`, if given, is checked between file-read chunks
 *  and before each decode/encode flush, so an abort lands promptly rather
 *  than after the whole file has been read. */
export async function extractAudio(file, onProgress, signal) {
  const size = file.size;
  const progress = makeProgress(onProgress);
  throwIfAborted(signal);

  // Loaded here, at call time, not at module scope — see mp4box-esm.js's
  // module comment for why a top-level await here would silently break a
  // worker's message handling.
  const { MP4Box, DataStream } = await loadMP4Box();

  const mp4 = MP4Box.createFile();
  let info = null;
  mp4.onError = () => {};
  mp4.onReady = (i) => { info = i; };

  // --- moov ---------------------------------------------------------------
  let pos = 0;
  while (!info && pos < size) {
    throwIfAborted(signal);
    const buf = await readRange(file, pos, Math.min(pos + CHUNK, size));
    const next = mp4.appendBuffer(buf);
    pos = (typeof next === 'number' && next > pos) ? next : pos + buf.byteLength;
  }
  if (!info) throw new Error('Could not read this file as MP4 — no moov box found.');
  progress(0.05);

  const aInfo = info.audioTracks[0];
  if (!aInfo) throw new Error('This recording has no audio track to transcribe.');

  const aTrak = mp4.getTrackById(aInfo.id);
  const aEntry = aTrak.mdia.minf.stbl.stsd.entries[0];
  const aDesc = audioDescription(aEntry);
  if (!aDesc) throw new Error('Could not read this file\'s audio codec configuration.');

  // --- sample extraction over the whole file ------------------------------
  // Unlike cut.js, there's no window: every audio sample in the file is
  // wanted, so this reads to end-of-file rather than stopping once a target
  // timestamp is reached. Video is never given extraction options, so
  // mp4box never buffers video sample data for us to discard.
  const aSamples = [];
  mp4.onSamples = (id, _user, samples) => {
    if (id === aInfo.id) for (const s of samples) aSamples.push(s);
  };
  mp4.setExtractionOptions(aInfo.id, null, { nbSamples: 400 });

  const seek = mp4.seek(0, true);
  mp4.start();
  pos = seek.offset;
  // The demux phase (this loop) is the bulk of the *reading*, but not of the
  // wall-clock time — like cut.js, the transcode dominates. Weight the demux
  // sweep into [0.05, 0.15] accordingly.
  //
  // Read straight through, ignoring appendBuffer()'s "next position" — it is
  // only trustworthy in the moov phase above, where skipping mdat is the
  // point. With moov at the *end* of the file (Zoom/OBS masters that were
  // never faststart-ed), mp4box still holds that moov buffer, and after the
  // first chunk of samples it reports the end of the file as next: honouring
  // it skipped all but ~25s of a 96-minute recording, so AssemblyAI only
  // ever heard the opening. Every byte of mdat is wanted here anyway.
  while (pos < size) {
    throwIfAborted(signal);
    const end = Math.min(pos + CHUNK, size);
    mp4.appendBuffer(await readRange(file, pos, end));
    pos = end;
    progress(0.05 + 0.1 * clamp01(pos / size));
  }
  mp4.stop();
  mp4.flush();
  progress(0.15);

  if (!aSamples.length) throw new Error('No audio samples found in this recording.');

  // --- probe the real decoded shape ---------------------------------------
  // SPIKE FINDING (carried over from cut.js): the container's sample_rate is
  // the AAC-LC core rate (22050 Hz in these masters, HE-AAC / mp4a.40.5);
  // SBR doubles it on decode, so the decoder actually emits 44100 Hz. The
  // muxer's audio track and the real encoder both need the *decoded*
  // rate — only a decoded frame knows it. Configuring either from the
  // container value throws "Unsupported sample rate".
  const aShape = await new Promise((resolve, reject) => {
    const probe = new AudioDecoder({
      output: (d) => {
        if (!resolved) { resolved = true; resolve({ sampleRate: d.sampleRate }); }
        d.close();
      },
      // Closed here too, not just on the success path — an
      // unconfigurable/undecodable probe left open would count against
      // Chrome's cap on concurrent hardware codec instances, the same class
      // of bug cut.js's comment warns about.
      error: (err) => {
        try { probe.close(); } catch { /* already closed */ }
        reject(new Error(`Could not decode this recording's audio: ${err.message}`));
      },
    });
    let resolved = false;
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
  progress(0.2);

  // --- transcode: decode the real source, downmix, encode mono AAC --------
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    audio: {
      codec: 'aac',
      sampleRate: aShape.sampleRate,
      numberOfChannels: 1,
    },
    fastStart: 'in-memory',
  });

  let encoder = null;
  let decoder = null;
  try {
    encoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: () => {},
    });
    encoder.configure({
      codec: 'mp4a.40.2', // always plain AAC-LC on the way out, same as cut.js
      sampleRate: aShape.sampleRate,
      numberOfChannels: 1,
      bitrate: AUDIO_BITRATE,
    });

    const totalUs = (aInfo.duration / aInfo.timescale) * 1e6 || 1;
    decoder = new AudioDecoder({
      output: (data) => {
        progress(0.2 + 0.79 * clamp01(data.timestamp / totalUs));
        const mono = downmixToMono(data);
        encoder.encode(mono);
        mono.close();
        data.close();
      },
      error: () => {},
    });
    // Decode as whatever the source actually is (HE-AAC in these masters);
    // see the probe comment above for why the re-encode is always AAC-LC.
    decoder.configure({
      codec: aInfo.codec,
      sampleRate: aInfo.audio.sample_rate,
      numberOfChannels: aInfo.audio.channel_count,
      description: aDesc,
    });

    for (const s of aSamples) {
      throwIfAborted(signal);
      decoder.decode(new EncodedAudioChunk({
        type: 'key',
        timestamp: (s.cts / s.timescale) * 1e6,
        duration: (s.duration / s.timescale) * 1e6,
        data: s.data,
      }));
    }
    await decoder.flush();
    await encoder.flush();
  } finally {
    for (const codec of [encoder, decoder]) {
      if (!codec) continue;
      try { codec.close(); } catch { /* already closed by its own error path */ }
    }
  }

  muxer.finalize();
  progress(1);
  return new Blob([muxer.target.buffer], { type: 'audio/mp4' });
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Wraps an optional onProgress so callers never see it go backwards or
 *  outside [0, 1], and is a safe no-op when onProgress isn't given.
 *  Identical to cut.js's makeProgress(). */
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
