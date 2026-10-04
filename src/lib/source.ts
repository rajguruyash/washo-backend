/** Marketing attribution: ?source=nfc | qr | whatsapp | pamphlet … captured on landing, sent at first login. */

const KEY = 'washo_source';
const VALID = /^[a-z0-9_-]{1,32}$/i;

export function captureSource(): void {
  try {
    const s = new URLSearchParams(window.location.search).get('source');
    if (s && VALID.test(s)) sessionStorage.setItem(KEY, s.toLowerCase());
  } catch {
    /* storage can be unavailable (private mode) */
  }
}

export function getSource(): string | undefined {
  try {
    return sessionStorage.getItem(KEY) || undefined;
  } catch {
    return undefined;
  }
}
