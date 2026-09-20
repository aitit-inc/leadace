// lib.dom types the Web Speech events but not the recognizer itself, and
// Chrome and Safari still only expose the prefixed constructor.
export interface SpeechRecognizer {
  continuous: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognizerConstructor = new () => SpeechRecognizer;

export function createRecognizer(): SpeechRecognizer | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognizerConstructor;
    webkitSpeechRecognition?: SpeechRecognizerConstructor;
  };
  const Recognizer = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return Recognizer ? new Recognizer() : null;
}
