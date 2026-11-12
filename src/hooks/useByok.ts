import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { validateProviderKey } from '../lib/ai';
import {
  buildModelList,
  defaultModelFor,
  describeKeyFormatProblem,
  detectProviderFromKey,
  getProviderMeta,
  looksLikeBaseUrl,
  looksLikeKeyFor,
  normalizeBaseUrl,
  type ModelInfo,
  type ProviderId
} from '../lib/providers';
import {
  getActiveProvider,
  getApiKey,
  getCustomBaseUrl,
  getCustomExtraModels,
  getSelectedModel,
  setActiveProvider as persistActiveProvider,
  setApiKey,
  setCustomBaseUrl as persistCustomBaseUrl,
  setCustomExtraModels as persistCustomExtraModels,
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
  temperature: number;
  setTemperature: (value: number) => void;
  /** Current key for the active provider, or '' when the user has none. */
  activeKey: string;
  /** Base URL for the BYOK custom endpoint. */
  baseUrl: string;
  setBaseUrl: (value: string) => void;
  /** Model ids typed by hand, for endpoints that do not implement /models. */
  extraModels: string[];
  setExtraModels: (modelIds: string[]) => void;
}

const IDLE: KeyStatus = { state: 'idle' };

const ALL_PROVIDERS: ProviderId[] = ['gemini', 'groq', 'custom'];

export function useByok(): UseByokResult {
  const [activeProvider, setActiveProviderState] = useState<ProviderId>(() => getActiveProvider());
  const [apiKeyDraft, setApiKeyDraftState] = useState<Record<ProviderId, string>>(() => ({
    gemini: getApiKey('gemini'),
    groq: getApiKey('groq'),
    custom: getApiKey('custom')
  }));
  /** Keys that actually passed validation — only these are sent upstream. */
  const [savedKeys, setSavedKeys] = useState<Record<ProviderId, string>>(() => ({
    gemini: getApiKey('gemini'),
    groq: getApiKey('groq'),
    custom: getApiKey('custom')
  }));
  const [keyStatus, setKeyStatus] = useState<Record<ProviderId, KeyStatus>>({
    gemini: { ...IDLE },
    groq: { ...IDLE },
    custom: { ...IDLE }
  });
  const [modelsByProvider, setModelsByProvider] = useState<Record<ProviderId, ModelInfo[]>>({
    gemini: [],
    groq: [],
    custom: []
  });
  const [selectedByProvider, setSelectedByProvider] = useState<Record<ProviderId, string>>(() => ({
    gemini: getSelectedModel('gemini'),
    groq: getSelectedModel('groq'),
    custom: getSelectedModel('custom')
  }));
  const [baseUrl, setBaseUrlState] = useState<string>(() => getCustomBaseUrl());
  const [extraModels, setExtraModelsState] = useState<string[]>(() => getCustomExtraModels());
  const [temperature, setTemperature] = useState(0.7);

  const validateKey = useCallback(
    async (provider: ProviderId) => {
      const candidate = (apiKeyDraft[provider] || '').trim();
      const endpoint = normalizeBaseUrl(baseUrl);

      if (provider === 'custom' && !looksLikeBaseUrl(endpoint)) {
        setKeyStatus((previous) => ({
          ...previous,
          [provider]: {
            state: 'error',
            message: 'Add the endpoint base URL first — for example https://openrouter.ai/api/v1, or http://127.0.0.1:11434/v1 for Ollama.'
          }
        }));
        return;
      }

      if (!candidate) {
        setKeyStatus((previous) => ({
          ...previous,
          [provider]: { state: 'error', message: 'Please enter an API key first.' }
        }));
        return;
      }

      // Pasting a Groq key into the Gemini field (or vice versa) is the most
      // common mistake, and it otherwise just looks like "nothing happened".
      // Skipped for a custom endpoint: gateways re-issue upstream credentials
      // under their own key, so a prefix identifies nothing there.
      const keyBelongsTo = provider === 'custom' ? null : detectProviderFromKey(candidate);
      if (keyBelongsTo && keyBelongsTo !== provider) {
        setKeyStatus((previous) => ({
          ...previous,
          [provider]: {
            state: 'error',
            message: `This appears to be a ${getProviderMeta(keyBelongsTo).label} key (${candidate.slice(0, 4)}...). Select ${getProviderMeta(keyBelongsTo).label} above, then paste the key there.`
          }
        }));
        return;
      }

      if (!looksLikeKeyFor(provider, candidate)) {
        setKeyStatus((previous) => ({
          ...previous,
          [provider]: {
            state: 'error',
            message: describeKeyFormatProblem(provider, candidate)
              ?? `Invalid key format for ${getProviderMeta(provider).label} — expected prefix ${getProviderMeta(provider).keyPrefix}.`
          }
        }));
        return;
      }

      setKeyStatus((previous) => ({ ...previous, [provider]: { state: 'checking' } }));

      try {
        const listed = await validateProviderKey(provider, candidate, endpoint || undefined);
        // Gateways that do not implement /models still work: the ids typed in
        // Settings become the picker, so "verified" never depends on a listing.
        const models =
          provider === 'custom' && listed.models.length === 0 && extraModels.length > 0
            ? buildModelList('custom', extraModels)
            : listed.models;

        if (provider === 'custom' && models.length === 0) {
          setApiKey(provider, candidate);
          setSavedKeys((previous) => ({ ...previous, [provider]: candidate }));
          setModelsByProvider((previous) => ({ ...previous, [provider]: [] }));
          setKeyStatus((previous) => ({
            ...previous,
            [provider]: {
              state: 'error',
              message: 'Key works, but this endpoint lists no models. Type the model id(s) you want under "Model ids", then Save & Test again.'
            }
          }));
          return;
        }

        setApiKey(provider, candidate);
        setSavedKeys((previous) => ({ ...previous, [provider]: candidate }));
        setModelsByProvider((previous) => ({ ...previous, [provider]: models }));

        const nextDefault = defaultModelFor(provider, models);
        setSelectedByProvider((previous) => {
          const stored = previous[provider];
          const stillValid = models.some((model) => model.id === stored);
          const chosen = stillValid ? stored : nextDefault;
          persistSelectedModel(provider, chosen);
          return { ...previous, [provider]: chosen };
        });

        setKeyStatus((previous) => ({
          ...previous,
          [provider]: {
            state: 'ok',
            latencyMs: listed.latencyMs,
            modelCount: models.length
          }
        }));
      } catch (error) {
        setModelsByProvider((previous) => ({ ...previous, [provider]: [] }));
        setKeyStatus((previous) => ({
          ...previous,
          [provider]: {
            state: 'error',
            message: error instanceof Error ? error.message : 'Unable to validate API key. Please check credentials and network.'
          }
        }));
      }
    },
    [apiKeyDraft, baseUrl, extraModels]
  );

  // Re-validate keys that are already saved so the model list is ready on load.
  const hasBootstrapped = useRef(false);
  useEffect(() => {
    if (hasBootstrapped.current) return;
    hasBootstrapped.current = true;
    ALL_PROVIDERS.forEach((provider) => {
      if (getApiKey(provider)) void validateKey(provider);
    });
  }, [validateKey]);

  const setBaseUrl = useCallback((value: string) => {
    setBaseUrlState(value);
    persistCustomBaseUrl(value);
    setKeyStatus((previous) => ({ ...previous, custom: { ...IDLE } }));
  }, []);

  const setExtraModels = useCallback((modelIds: string[]) => {
    const cleaned = modelIds.map((id) => id.trim()).filter(Boolean);
    setExtraModelsState(cleaned);
    persistCustomExtraModels(cleaned);
  }, []);

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

  const byokModels = useMemo(() => {
    const listed = modelsByProvider[activeProvider];
    if (activeProvider !== 'custom') return listed;
    // Hand-typed ids join whatever the endpoint listed, so an endpoint without
    // /models is still usable and one that gains a listing keeps both.
    const known = new Set(listed.map((model) => model.id));
    return [...listed, ...buildModelList('custom', extraModels).filter((model) => !known.has(model.id))];
  }, [activeProvider, modelsByProvider, extraModels]);

  const models = byokModels;

  const selectedModel = useMemo(() => {
    if (byokModels.length === 0) return '';
    const stored = selectedByProvider[activeProvider];
    if (stored && byokModels.some((model) => model.id === stored)) return stored;
    return defaultModelFor(activeProvider, byokModels);
  }, [byokModels, selectedByProvider, activeProvider]);

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
      temperature,
      setTemperature,
      activeKey,
      baseUrl,
      setBaseUrl,
      extraModels,
      setExtraModels
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
      temperature,
      activeKey,
      baseUrl,
      setBaseUrl,
      extraModels,
      setExtraModels
    ]
  );
}
