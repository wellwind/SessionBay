import { api, isDesktop } from './api';
import type { AttentionKind } from './runtime-activity';

const PRIORITY: Record<AttentionKind, number> = { done: 0, failed: 1, waiting: 2 };
export const ATTENTION_COALESCE_MS = 1_500;
export const PANE_COOLDOWN_MS = 5_000;

/** A fixed window lets later, higher-priority events replace the pending tone. */
export class AttentionSoundBurst {
  private pending?: AttentionKind;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private play: (kind: AttentionKind) => void) {}
  enqueue(kind: AttentionKind) {
    if (!this.pending || PRIORITY[kind] > PRIORITY[this.pending]) this.pending = kind;
    this.timer ??= setTimeout(() => {
      const selected = this.pending;
      this.pending = undefined; this.timer = undefined;
      if (selected) this.play(selected);
    }, ATTENTION_COALESCE_MS);
  }
  cancel() {
    clearTimeout(this.timer); this.timer = undefined; this.pending = undefined;
  }
}

let context: AudioContext | undefined;
function audioContext() {
  if (!context || context.state === 'closed') context = new AudioContext();
  return context;
}

/** Resume within a user gesture so subsequent background events can use Web Audio. */
export function unlockAttentionAudio() {
  try {
    const audio = audioContext();
    if (audio.state !== 'running') void audio.resume().catch(error => console.debug('Attention audio resume failed', error));
  } catch (error) { console.debug('Attention audio unavailable', error); }
}

const TONES: Record<AttentionKind, { frequencies: number[]; duration: number; type: OscillatorType }> = {
  done: { frequencies: [660, 880], duration: 0.13, type: 'sine' },
  waiting: { frequencies: [880, 660, 880], duration: 0.16, type: 'triangle' },
  failed: { frequencies: [220, 165], duration: 0.22, type: 'sine' },
};

/** Previews bypass event gating and cooldowns, but still respect volume and detected DND. */
export async function playAttentionSound(kind: AttentionKind, volume: number, current: () => boolean = () => true) {
  if (!Number.isFinite(volume) || volume <= 0) return;
  try {
    const audio = audioContext();
    // Start resuming before IPC so a preview retains its user activation.
    const resumed = audio.state === 'running' ? Promise.resolve() : audio.resume();
    const muted = isDesktop() ? api.attentionSoundMuted().catch(error => {
      console.debug('Attention DND detection failed; playing as usual', error);
      return false;
    }) : Promise.resolve(false);
    const [, suppress] = await Promise.all([resumed, muted]);
    if (suppress || !current() || audio.state !== 'running') return;
    const tone = TONES[kind], start = audio.currentTime + 0.01;
    tone.frequencies.forEach((frequency, index) => {
      const oscillator = audio.createOscillator(), gain = audio.createGain();
      const at = start + index * (tone.duration + 0.035);
      oscillator.type = tone.type;
      oscillator.frequency.setValueAtTime(frequency, at);
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(Math.min(100, volume) / 100 * 0.18, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + tone.duration);
      oscillator.connect(gain); gain.connect(audio.destination);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      oscillator.start(at); oscillator.stop(at + tone.duration);
    });
  } catch (error) { console.debug('Attention sound playback failed', error); }
}
