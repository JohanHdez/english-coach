// Opens the other speaker's stream, with its two flavours of capture id:
//   tabCapture     -> chromeMediaSource 'tab'
//   desktopCapture -> chromeMediaSource 'desktop' (Chrome's native picker)
//
// Critical difference: with 'desktop' you must ALWAYS request video alongside
// audio. Asking for audio only with a desktopCapture id is a request the browser
// process considers invalid, and it answers by killing the renderer
// (RESULT_CODE_KILLED_BAD_MESSAGE) without throwing anything catchable. The video
// is requested at the smallest possible size and dropped as soon as the stream
// arrives.

export function captureConstraints(kind, streamId, withVideo = false) {
  const source = kind === 'desktop' ? 'desktop' : 'tab';
  const constraints = {
    audio: { mandatory: { chromeMediaSource: source, chromeMediaSourceId: streamId } },
  };
  if (withVideo) {
    constraints.video = {
      mandatory: {
        chromeMediaSource: source,
        chromeMediaSourceId: streamId,
        maxWidth: 160, maxHeight: 120, maxFrameRate: 1,
      },
    };
  }
  return constraints;
}

// Attempt order per capture kind. For 'desktop' an audio-only attempt is never
// tried: it does not fail, it kills the process.
export function attemptsFor(kind) {
  return kind === 'desktop' ? [true] : [false, true];
}

export async function openCaptureStream(kind, streamId, gum) {
  const get = gum || ((c) => navigator.mediaDevices.getUserMedia(c));
  let stream;
  let firstError;

  for (const withVideo of attemptsFor(kind)) {
    try {
      stream = await get(captureConstraints(kind, streamId, withVideo));
      break;
    } catch (e) {
      firstError = firstError || e;
    }
  }
  if (!stream) throw firstError || new Error('No se pudo abrir el audio de la pestaña.');

  for (const track of stream.getVideoTracks()) {
    track.stop();
    stream.removeTrack(track);
  }

  if (!stream.getAudioTracks().length) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('La pestaña se compartió sin audio. Repite y marca «Compartir audio de la pestaña» en el selector de Chrome.');
  }

  return stream;
}
