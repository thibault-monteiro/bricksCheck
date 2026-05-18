// Plays a short "ding-dong" via the Web Audio API on demand from the
// service worker, which can't play audio itself in MV3. Loaded inside
// the offscreen document created with the AUDIO_PLAYBACK reason.

const SOUND_MESSAGE_TYPE = "BRICKS_PLAY_SOUND";
const NOTE_1_HZ = 880;   // A5
const NOTE_2_HZ = 1320;  // E6 — perfect fifth above
const NOTE_DURATION = 0.18;
const NOTE_GAP = 0.04;
const PEAK_GAIN = 0.25;
const ATTACK = 0.01;
const RELEASE = 0.04;

let audioContext = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== SOUND_MESSAGE_TYPE) return false;
  playDingDong()
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});

async function playDingDong() {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  if (audioContext.state === "suspended") {
    try {
      await audioContext.resume();
    } catch {
      // ignore — playTone will still try
    }
  }
  const start = audioContext.currentTime;
  playTone(NOTE_1_HZ, start, NOTE_DURATION);
  playTone(NOTE_2_HZ, start + NOTE_DURATION + NOTE_GAP, NOTE_DURATION);
}

function playTone(frequency, startTime, duration) {
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = frequency;
  // Envelope: linear attack to PEAK_GAIN, hold, linear release to 0.
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(PEAK_GAIN, startTime + ATTACK);
  gain.gain.setValueAtTime(PEAK_GAIN, startTime + duration - RELEASE);
  gain.gain.linearRampToValueAtTime(0, startTime + duration);
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start(startTime);
  oscillator.stop(startTime + duration + 0.02);
}
