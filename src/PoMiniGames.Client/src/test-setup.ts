import '@testing-library/jest-dom';

/**
 * Some jsdom configurations ship an incomplete Web Storage implementation
 * that omits `clear()`.  Provide a full in-memory replacement so library
 * code and tests can always rely on the standard Storage API.
 */
const makeStorage = (): Storage => {
  const store: Record<string, string> = {};
  return {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => {
      store[k] = String(v);
    },
    removeItem: (k) => {
      delete store[k];
    },
    clear: () => {
      Object.keys(store).forEach((k) => delete store[k]);
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (i) => Object.keys(store)[i] ?? null,
  };
};

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'localStorage', {
    value: makeStorage(),
    writable: true,
  });
  Object.defineProperty(window, 'sessionStorage', {
    value: makeStorage(),
    writable: true,
  });
}
