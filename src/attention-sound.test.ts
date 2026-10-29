import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { muted } = vi.hoisted(() => ({ muted: vi.fn() }));
vi.mock('./api', () => ({ isDesktop: () => true, api: { attentionSoundMuted: muted } }));

const parameter = () => ({ setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });
let audio: ReturnType<typeof fakeAudio>;
function fakeAudio() {
  return {
    state: 'running', currentTime: 10, destination: {}, resume: vi.fn().mockResolvedValue(undefined),
    createOscillator: vi.fn(() => ({ type: '', frequency: parameter(), connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null })),
    createGain: vi.fn(() => ({ gain: parameter(), connect: vi.fn(), disconnect: vi.fn() })),
  };
}

beforeEach(() => {
  vi.resetModules();
  muted.mockReset().mockResolvedValue(false);
  audio = fakeAudio();
  vi.stubGlobal('AudioContext', class { constructor() { return audio; } });
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('attention sound bursts', () => {
  it.each([
    [['done', 'failed'], 'failed'], [['failed', 'done'], 'failed'],
    [['waiting', 'failed', 'done'], 'waiting'], [['done', 'waiting'], 'waiting'], [['done', 'done'], 'done'],
  ] as const)('chooses one priority tone for %j', async (events, selected) => {
    vi.useFakeTimers();
    const { AttentionSoundBurst } = await import('./attention-sound');
    const play = vi.fn(), burst = new AttentionSoundBurst(play);
    for (const kind of events) burst.enqueue(kind);
    vi.advanceTimersByTime(1499); expect(play).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(play).toHaveBeenCalledExactlyOnceWith(selected);
    burst.enqueue('done'); vi.advanceTimersByTime(1500);
    expect(play).toHaveBeenCalledTimes(2);
    burst.enqueue('waiting'); burst.cancel(); vi.advanceTimersByTime(1500);
    expect(play).toHaveBeenCalledTimes(2);
  });
});

describe('Web Audio playback', () => {
  it.each([['done', [660, 880]], ['waiting', [880, 660, 880]], ['failed', [220, 165]]] as const)('synthesizes the %s tone at the requested volume', async (kind, frequencies) => {
    const { playAttentionSound } = await import('./attention-sound');
    await playAttentionSound(kind, 70);
    expect(muted).toHaveBeenCalledOnce();
    expect(audio.createOscillator).toHaveBeenCalledTimes(frequencies.length);
    frequencies.forEach((frequency, index) => {
      const oscillator = audio.createOscillator.mock.results[index].value;
      expect(oscillator.frequency.setValueAtTime).toHaveBeenCalledWith(frequency, expect.any(Number));
      expect(oscillator.start).toHaveBeenCalledOnce();
      expect(oscillator.stop).toHaveBeenCalledOnce();
      expect(audio.createGain.mock.results[index].value.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.126, expect.any(Number));
    });
  });
  it('mutes DND and zero volume, and cancels stale playback after IPC', async () => {
    const { playAttentionSound } = await import('./attention-sound');
    muted.mockResolvedValue(true);
    await playAttentionSound('waiting', 70);
    muted.mockResolvedValue(false);
    await playAttentionSound('done', 0);
    await playAttentionSound('failed', 70, () => false);
    expect(audio.createOscillator).not.toHaveBeenCalled();
  });
  it('fails open with a debug log when DND detection fails', async () => {
    const { playAttentionSound } = await import('./attention-sound');
    muted.mockRejectedValue(new Error('synthetic IPC failure'));
    await playAttentionSound('done', 50);
    expect(audio.createOscillator).toHaveBeenCalledTimes(2);
    expect(console.debug).toHaveBeenCalled();
  });
  it('previews bypass cooldowns and resume synchronously before querying DND', async () => {
    const { playAttentionSound } = await import('./attention-sound');
    audio.state = 'suspended';
    audio.resume.mockImplementation(async () => { audio.state = 'running'; });
    const first = playAttentionSound('done', 25);
    expect(audio.resume).toHaveBeenCalledOnce();
    await first;
    await playAttentionSound('done', 25);
    expect(audio.createOscillator).toHaveBeenCalledTimes(4);
  });
  it('handles a rejected background resume without an unhandled rejection', async () => {
    const { playAttentionSound, unlockAttentionAudio } = await import('./attention-sound');
    audio.state = 'suspended';
    audio.resume.mockRejectedValue(new Error('synthetic autoplay denial'));
    unlockAttentionAudio();
    await playAttentionSound('failed', 70);
    expect(audio.createOscillator).not.toHaveBeenCalled();
    expect(console.debug).toHaveBeenCalled();
  });
});
