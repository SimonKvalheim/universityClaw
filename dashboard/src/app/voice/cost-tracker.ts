import { type Rates, type TokenUsage, computeCostUsd } from './rates';

type ChangeListener = (costUsd: number) => void;

export class CostTracker {
  private _totals: TokenUsage = { textIn: 0, textOut: 0, audioIn: 0, audioOut: 0 };
  private readonly _listeners = new Set<ChangeListener>();

  constructor(private readonly rates: Rates) {}

  get totals(): Readonly<TokenUsage> {
    return { ...this._totals };
  }

  get costUsd(): number {
    return computeCostUsd(this._totals, this.rates);
  }

  addUsage(usage: TokenUsage): void {
    this._totals.textIn += usage.textIn ?? 0;
    this._totals.textOut += usage.textOut ?? 0;
    this._totals.audioIn += usage.audioIn ?? 0;
    this._totals.audioOut += usage.audioOut ?? 0;
    this._emit();
  }

  reset(): void {
    this._totals = { textIn: 0, textOut: 0, audioIn: 0, audioOut: 0 };
    this._emit();
  }

  onChange(cb: ChangeListener): void {
    this._listeners.add(cb);
  }

  offChange(cb: ChangeListener): void {
    this._listeners.delete(cb);
  }

  private _emit(): void {
    const c = this.costUsd;
    for (const cb of this._listeners) {
      cb(c);
    }
  }
}
