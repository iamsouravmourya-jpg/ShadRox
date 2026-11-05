import { useEffect, useRef, useState } from 'react';

/** Why dictation stopped before it produced text. */
export type SpeechErrorCode =
  | 'not-supported'
  | 'not-allowed'
  | 'service-not-allowed'
  | 'audio-capture'
  | 'no-speech'
  | 'network'
  | 'aborted'
  | 'language-not-supported'
  | 'unknown';

/** A dictation failure the UI can actually show, instead of a silent console.warn. */
export interface SpeechRecognitionError {
  code: SpeechErrorCode;
  message: string;
}

interface UseSpeechRecognitionResult {
  isSupported: boolean;
  isListening: boolean;
  transcript: string;
  /** Non-null while the last attempt failed; cleared on the next `start`. */
  error: SpeechRecognitionError | null;
  start: () => void;
  stop: () => void;
  reset: () => void;
}

const ERROR_MESSAGES: Record<SpeechErrorCode, string> = {
  'not-supported': 'Voice dictation is not available in this build. Type the message instead.',
  'not-allowed': 'Microphone permission was denied. Allow the mic for ShadRox, then try again.',
  'service-not-allowed': 'The system speech service refused this request. Check the microphone privacy settings.',
  'audio-capture': 'No microphone was found. Connect one and try again.',
  'no-speech': 'No speech was detected. Try again and speak after the mic turns red.',
  network: 'The speech service could not be reached. Check your connection and try again.',
  aborted: 'Dictation stopped before anything was heard.',
  'language-not-supported': 'This language is not supported by the system speech service.',
  unknown: 'Voice dictation failed. Type the message instead.'
};

function toSpeechError(raw: unknown): SpeechRecognitionError {
  const code = typeof raw === 'string' && raw in ERROR_MESSAGES ? (raw as SpeechErrorCode) : 'unknown';
  return { code, message: ERROR_MESSAGES[code] };
}

/**
 * Thin wrapper over the Web Speech API. Kept in a hook so voice state does not
 * leak into the chat component. Every failure surfaces through `error` so the
 * mic button can say what went wrong.
 */
export function useSpeechRecognition(lang = 'hi-IN'): UseSpeechRecognitionResult {
  const recognitionRef = useRef<any>(null);
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<SpeechRecognitionError | null>(null);
  const isSupported = typeof window !== 'undefined' && Boolean((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

  useEffect(() => {
    if (!isSupported) return;

    const SpeechRecognitionCtor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = lang;

    recognition.onstart = () => {
      setIsListening(true);
      setTranscript('');
      setError(null);
    };

    recognition.onresult = (event: any) => {
      let text = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        text += event.results[i][0].transcript;
      }
      setTranscript(text);
    };

    recognition.onerror = (event: any) => {
      setError(toSpeechError(event?.error));
      setIsListening(false);
    };

    recognition.onend = () => setIsListening(false);

    recognitionRef.current = recognition;

    return () => {
      try {
        recognition.stop();
      } catch {
        /* ignore */
      }
      recognitionRef.current = null;
    };
  }, [isSupported, lang]);

  const start = () => {
    if (!isSupported) {
      setError(toSpeechError('not-supported'));
      return;
    }
    if (!recognitionRef.current) {
      setError(toSpeechError('unknown'));
      return;
    }
    setTranscript('');
    setError(null);
    try {
      recognitionRef.current.start();
      setIsListening(true);
    } catch (startError) {
      // `start()` throws when the recogniser is already running; anything else
      // is a real failure the user should see.
      const message = startError instanceof Error ? startError.message : String(startError);
      if (!/already started/i.test(message)) setError(toSpeechError('unknown'));
      setIsListening(false);
    }
  };

  const stop = () => {
    if (!recognitionRef.current) return;
    try {
      recognitionRef.current.stop();
    } catch {
      /* ignore */
    }
    setIsListening(false);
  };

  const reset = () => setTranscript('');

  return { isSupported, isListening, transcript, error, start, stop, reset };
}
