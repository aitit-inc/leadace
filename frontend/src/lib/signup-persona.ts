import type { Cookies } from '@sveltejs/kit';

// The same slugs as the ?for= script in landing/public/index.html.
export const SIGNUP_PERSONAS = ['build', 'rejection', 'busy', 'validate'] as const;
export type SignupPersona = (typeof SIGNUP_PERSONAS)[number];

export const PERSONA_COOKIE = 'lp-persona';
// The cookie's lifetime: only an account created within it takes the persona.
export const PERSONA_WINDOW_MS = 10 * 60 * 1000;

export function signupPersona(raw: string | null | undefined): SignupPersona | null {
  return SIGNUP_PERSONAS.find((p) => p === raw) ?? null;
}

export function takeSignupPersona(cookies: Cookies): SignupPersona | null {
  const raw = cookies.get(PERSONA_COOKIE);
  if (raw === undefined) return null;
  cookies.delete(PERSONA_COOKIE, { path: '/' });
  return signupPersona(raw);
}
