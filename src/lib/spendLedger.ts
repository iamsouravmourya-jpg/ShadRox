export interface TokenSpendRecord {
  id: string;
  timestamp: number;
  provider: string;
  model: string;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  estimatedSavedUsd: number;
}

export interface SpendLedgerSummary {
  totalPromptTokens: number;
  totalCachedTokens: number;
  totalCompletionTokens: number;
  totalCostUsd: number;
  cacheSavingsUsd: number;
  cacheHitRatio: number;
}

export class SpendLedger {
  private records: TokenSpendRecord[] = [];

  public recordTurnSpend(params: {
    provider: string;
    model: string;
    promptTokens: number;
    cachedTokens?: number;
    completionTokens: number;
    inputPricePerMillion?: number;
    outputPricePerMillion?: number;
    cacheReadPricePerMillion?: number;
  }): TokenSpendRecord {
    const cachedTokens = params.cachedTokens || 0;
    const basePromptTokens = Math.max(0, params.promptTokens - cachedTokens);

    const inputRate = params.inputPricePerMillion ?? 0.15; // default reasonable rate per million
    const outputRate = params.outputPricePerMillion ?? 0.60;
    const cacheRate = params.cacheReadPricePerMillion ?? 0.0375; // ~75% discount

    const inputCost = (basePromptTokens / 1_000_000) * inputRate;
    const cacheCost = (cachedTokens / 1_000_000) * cacheRate;
    const outputCost = (params.completionTokens / 1_000_000) * outputRate;
    const estimatedCostUsd = inputCost + cacheCost + outputCost;

    // Calculate how much was saved vs non-cached input
    const unCachedInputCost = (cachedTokens / 1_000_000) * inputRate;
    const estimatedSavedUsd = Math.max(0, unCachedInputCost - cacheCost);

    const record: TokenSpendRecord = {
      id: `spend-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      provider: params.provider,
      model: params.model,
      promptTokens: params.promptTokens,
      cachedTokens,
      completionTokens: params.completionTokens,
      estimatedCostUsd: Math.round(estimatedCostUsd * 100000) / 100000,
      estimatedSavedUsd: Math.round(estimatedSavedUsd * 100000) / 100000
    };

    this.records.push(record);
    return record;
  }

  public getSummary(): SpendLedgerSummary {
    let totalPrompt = 0;
    let totalCached = 0;
    let totalCompletion = 0;
    let totalCost = 0;
    let totalSaved = 0;

    for (const r of this.records) {
      totalPrompt += r.promptTokens;
      totalCached += r.cachedTokens;
      totalCompletion += r.completionTokens;
      totalCost += r.estimatedCostUsd;
      totalSaved += r.estimatedSavedUsd;
    }

    const totalInput = totalPrompt + totalCached;
    const cacheHitRatio = totalInput > 0 ? totalCached / totalInput : 0;

    return {
      totalPromptTokens: totalPrompt,
      totalCachedTokens: totalCached,
      totalCompletionTokens: totalCompletion,
      totalCostUsd: Math.round(totalCost * 10000) / 10000,
      cacheSavingsUsd: Math.round(totalSaved * 10000) / 10000,
      cacheHitRatio: Math.round(cacheHitRatio * 100) / 100
    };
  }

  public getRecords(): readonly TokenSpendRecord[] {
    return this.records;
  }

  public clear(): void {
    this.records.length = 0;
  }
}

export const globalSpendLedger = new SpendLedger();
