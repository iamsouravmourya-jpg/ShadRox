import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { validateProviderKey } from '../lib/ai';
import { defaultModelFor, detectProviderFromKey, getProviderMeta, looksLikeKeyFor, type ModelInfo, type ProviderId } from '../lib/providers';
import {
  getActiveProvider,
  getApiKey,
  getSelectedModel,
  setActiveProvider as persistActiveProvider,
  setApiKey,
  setSelectedModel as persistSelectedModel
} from '../lib/storage';
import type { KeyStatus } from '../lib/types';

interface UseByokResult {
  activeProvider: ProviderId;
  changeProvider: (provider: ProviderId) => void;
  apiKeyDraft: Record<ProviderId, string>;
  setApiKeyDraft: (provider: ProviderId, value: string) => void;
  keyStatus: Record<ProviderId, KeyStatus>;
  validateKey: (provider: ProviderId) => Promise<void>;
  forgetKey: (provider: ProviderId) => void;
  models: ModelInfo[];
  selectedModel: string;
  selectModel: (modelId: string) => void;
  useDevoraKey: boolean;
  setUseDevoraKey: (value: boolean) => void;
  temperature: number;
  setTemperature: (value: number) => void;
  /** Current key for the active provider, or '' when the user has none. */
  activeKey: string;
}

const IDLE: KeyStatus = { state: 'idle' };

export function useByok(): UseByokResult {
  const [activeProvider, setActiveProviderState] = useState<ProviderId>(() => getActiveProvider());
  const [apiKeyDraft, setApiKeyDraftState] = useState<Record<ProviderId, string>>(() => ({
    gemini: getApiKey('gemini'),
    groq: getApiKey('groq')
  }));
  /** Keys that actually passed validation — only these are sent upstream. */
  const [savedKeys, setSavedKeys] = useState<Record<ProviderId, string>>(() => ({
    gemini: getApiKey('gemini'),
    groq: getApiKey('groq')
  }));
  const [keyStatus, setKeyStatus] = useState<Record<ProviderId, KeyStatus>>({
    gemini: { ...IDLE },
    groq: { ...IDLE }
  });
  const [modelsByProvider, setModelsByProvider] = useState<Record<ProviderId, ModelInfo[]>>({
    gemini: [],
    groq: []
  });
  const [selectedByProvider, setSelectedByProvider] = useState<Record<ProviderId, string>>(() => ({
    gemini: getSelectedModel('gemini'),
    groq: getSelectedModel('groq')
  }));
  const [useDevoraKey, setUseDevoraKey] = useState(false);
  const [temperature, setTemperature] = useState(0.7);

  const validateKey = useCallback(
    async (provider: ProviderId) => {
      const candidate = (apiKeyDraft[provider] || '').trim();

      if (!candidate) {
        setKeyStatus((previous) => ({
          ...previous,
          [provider]: { state: 'error', message: 'Pehle API key paste karo.' }
        }));
        return;
      }

      // Pasting a Groq key into the Gemini field (or vice versa) is the most
      // common mistake, and it otherwise just looks like "nothing happened".
      const keyBelongsTo = detectProviderFromKey(candidate);
      if (keyBelongsTo && keyBelongsTo !== provider) {
        setKeyStatus((previous) => ({
          ...previous,
          [provider]: {
            state: 'error',
            message: `Ye ${getProviderMeta(keyBelongsTo).label} ki key hai (${candidate.slice(0, 4)}...). Upar ${getProviderMeta(keyBelongsTo).label} select karo, phir key waha paste karo.`
          }
        }));
        return;
      }

      if (!looksLikeKeyFor(provider, candidate)) {
        setKeyStatus((previous) => ({
          ...previous,
          [provider]: {
            state: 'error',
            message: `Ye ${getProviderMeta(provider).label} ki key nahi lag rahi — ${getProviderMeta(provider).keyPrefix} se shuru honi chahiye.`
          }
        }));
        return;
      }

      setKeyStatus((previous) => ({ ...previous, [provider]: { state: 'checking' } }));

      try {
        const result = await validateProviderKey(provider, candidate);
        setApiKey(provider, candidate);
        setSavedKeys((previous) => ({ ...previous, [provider]: candidate }));
        setModelsByProvider((previous) => ({ ...previous, [provider]: result.models }));

        const nextDefault = defaultModelFor(provider, result.models);
        setSelectedByProvider((previous) => {
          const stored = previous[provider];
          const stillValid = result.models.some((model) => model.id === stored);
          const chosen = stillValid ? stored : nextDefault;
          persistSelectedModel(provider, chosen);
          return { ...previous, [provider]: chosen };
        });

        if (provider === activeProvider) setUseDevoraKey(false);

        setKeyStatus((previous) => ({
          ...previous,
          [provider]: {
            state: 'ok',
            latencyMs: result.latencyMs,
            modelCount: result.models.length
          }
        }));
      } catch (error) {
        setModelsByProvider((previous) => ({ ...previous, [provider]: [] }));
        setKeyStatus((previous) => ({
          ...previous,
          [provider]: {
            state: 'error',
            message: error instanceof Error ? error.message : 'Key validate nahi ho payi.'
          }
        }));
      }
    },
    [apiKeyDraft, activeProvider]
  );

  // Re-validate keys that are already saved so the model list is ready on load.
  const hasBootstrapped = useRef(false);
  useEffect(() => {
    if (hasBootstrapped.current) return;
    hasBootstrapped.current = true;
    (['gemini', 'groq'] as ProviderId[]).forEach((provider) => {
      if (getApiKey(provider)) void validateKey(provider);
    });
  }, [validateKey]);

  const setApiKeyDraft = useCallback((provider: ProviderId, value: string) => {
    setApiKeyDraftState((previous) => ({ ...previous, [provider]: value }));
    setKeyStatus((previous) => ({ ...previous, [provider]: { ...IDLE } }));
  }, []);

  const forgetKey = useCallback((provider: ProviderId) => {
    setApiKey(provider, '');
    setApiKeyDraftState((previous) => ({ ...previous, [provider]: '' }));
    setSavedKeys((previous) => ({ ...previous, [provider]: '' }));
    setModelsByProvider((previous) => ({ ...previous, [provider]: [] }));
    setSelectedByProvider((previous) => ({ ...previous, [provider]: '' }));
    persistSelectedModel(provider, '');
    setKeyStatus((previous) => ({ ...previous, [provider]: { ...IDLE } }));
  }, []);

  const changeProvider = useCallback((provider: ProviderId) => {
    setActiveProviderState(provider);
    persistActiveProvider(provider);
  }, []);

  const selectModel = useCallback(
    (modelId: string) => {
      setSelectedByProvider((previous) => ({ ...previous, [activeProvider]: modelId }));
      persistSelectedModel(activeProvider, modelId);
    },
    [activeProvider]
  );

  const models = modelsByProvider[activeProvider];
  const selectedModel =
    selectedByProvider[activeProvider] || defaultModelFor(activeProvider, models);
  const activeKey = savedKeys[activeProvider] || '';

  return useMemo(
    () => ({
      activeProvider,
      changeProvider,
      apiKeyDraft,
      setApiKeyDraft,
      keyStatus,
      validateKey,
      forgetKey,
      models,
      selectedModel,
      selectModel,
      useDevoraKey,
      setUseDevoraKey,
      temperature,
      setTemperature,
      activeKey
    }),
    [
      activeProvider,
      changeProvider,
      apiKeyDraft,
      setApiKeyDraft,
      keyStatus,
      validateKey,
      forgetKey,
      models,
      selectedModel,
      selectModel,
      useDevoraKey,
      temperature,
      activeKey
    ]
  );
}
