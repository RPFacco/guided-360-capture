// Spoken hints, recorded with ElevenLabs (voice: Matilda). One reused <audio>: iOS only
// lets a page start audio from a tap, and the element unlocked there stays unlocked.
const STORE_KEY = "guided-360-voice";
const clip = new Audio();

let muted = false;
try { muted = localStorage.getItem(STORE_KEY) === "off"; } catch (_) {}
let current = null;      // the hint for what the prompt says now
let introOn = false;
let afterIntro = false;  // current waits for the intro to end

export const voiceMuted = () => muted;

function play(name) {
  introOn = name === "intro";
  if (!introOn) afterIntro = false;
  clip.src = `audio/${name}.mp3`;
  clip.play().catch(() => { introOn = false; });
}

clip.addEventListener("ended", () => {
  introOn = false;
  if (afterIntro && current) play(current);
  afterIntro = false;
});

// From the start tap: a fresh capture opens with the intro, a resumed one only unlocks.
export function startVoice(intro) {
  current = null;
  afterIntro = false;
  if (intro && !muted) play("intro");
  else clip.load();
}

export function stopVoice() {
  clip.pause();
  introOn = afterIntro = false;
}

export function say(name) {
  if (name === current) return;
  current = name;
  if (muted || document.hidden || !name) return;
  if (introOn) afterIntro = true;
  else play(name);
}

// Back from another app: the hint may have changed while hidden.
export function resumeVoice() {
  if (!muted && current) play(current);
}

// The repeat tap plays even when muted. Before the first photo it repeats the intro too.
export function repeatVoice(withIntro) {
  if (withIntro) {
    play("intro");
    afterIntro = current !== null;
  } else if (current) {
    play(current);
  }
}

export function toggleVoice() {
  muted = !muted;
  try { localStorage.setItem(STORE_KEY, muted ? "off" : "on"); } catch (_) {}
  if (muted) stopVoice();
  else resumeVoice();
}
