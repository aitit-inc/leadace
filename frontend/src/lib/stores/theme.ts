import { writable } from 'svelte/store';

export type ThemeChoice = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'leadace.theme';

function readStored(): ThemeChoice {
  if (typeof localStorage === 'undefined') return 'system';
  const v = localStorage.getItem(STORAGE_KEY);
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
}

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyClass(choice: ThemeChoice) {
  if (typeof document === 'undefined') return;
  const effective = choice === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : choice;
  document.documentElement.classList.toggle('dark', effective === 'dark');
}

function createThemeStore() {
  const initial = readStored();
  const { subscribe, set } = writable<ThemeChoice>(initial);

  if (typeof window !== 'undefined') {
    applyClass(initial);

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', () => {
      const current = readStored();
      if (current === 'system') applyClass('system');
    });
  }

  return {
    subscribe,
    setChoice(choice: ThemeChoice) {
      if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, choice);
      applyClass(choice);
      set(choice);
    },
  };
}

export const theme = createThemeStore();
