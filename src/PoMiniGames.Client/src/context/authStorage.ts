const ACCESS_TOKEN_KEY = 'pomini_auth_access_token';
const RETURN_URL_KEY = 'pomini_auth_return_url';

export function getStoredAccessToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function setStoredAccessToken(token: string | null) {
  if (typeof window === 'undefined') return;
  if (token) {
    window.localStorage.setItem(ACCESS_TOKEN_KEY, token);
    return;
  }

  window.localStorage.removeItem(ACCESS_TOKEN_KEY);
}

export function consumePendingReturnUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const value = window.sessionStorage.getItem(RETURN_URL_KEY);
  if (value) {
    window.sessionStorage.removeItem(RETURN_URL_KEY);
  }

  return value;
}