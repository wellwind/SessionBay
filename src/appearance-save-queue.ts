import type { Settings } from './types';
import type { Appearance } from './themes';

type Patch = Partial<Appearance>;
interface Request {
  patch: Patch;
  resolve: (saved: boolean) => void;
  reject: (error: unknown) => void;
}
interface Options {
  getSettings: () => Settings | undefined;
  save: (settings: Settings) => Promise<Settings>;
  beforeSave: (patch: Patch) => Promise<void> | void;
  committed: (patch: Patch) => void;
  busy: (saving: boolean) => void;
}

/** One full-settings writer; callers own narrow fields and their own outcome. */
export class AppearanceSaveQueue {
  private requests: Request[] = [];
  private running = false;
  constructor(private readonly options: Options) {}

  persist(patch: Patch): Promise<boolean> {
    const result = new Promise<boolean>((resolve, reject) => {
      this.requests.push({ patch: { ...patch }, resolve, reject });
    });
    void this.drain();
    return result;
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    this.options.busy(true);
    try {
      while (this.requests.length) {
        const batch = this.requests.splice(0);
        const patch: Patch = Object.assign({}, ...batch.map(request => request.patch));
        try {
          const preparation = this.options.beforeSave(patch);
          if (preparation) await preparation;
          // Native work can be delayed. Read the current baseline only afterwards.
          const current = this.options.getSettings();
          if (!current) throw new Error('設定尚未載入。');
          const saved = await this.options.save({ ...current, ...patch });
          const committed = Object.fromEntries(Object.keys(patch).map(key => [key, saved[key as keyof Settings]])) as Patch;
          this.options.committed(committed);
          for (const request of batch)
            request.resolve(Object.entries(request.patch).every(([key, value]) => saved[key as keyof Settings] === value));
        } catch (error) {
          // The optimistic preview of all affected callers must roll back together.
          for (const request of [...batch, ...this.requests.splice(0)]) request.reject(error);
        }
      }
    } finally {
      this.running = false;
      this.options.busy(false);
    }
  }
}
