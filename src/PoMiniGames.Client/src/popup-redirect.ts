import { PublicClientApplication } from '@azure/msal-browser';

const POPUP_CONFIG_KEY = 'msal_popup_config';

interface PopupConfig {
  clientId: string;
  authority: string;
}

(async () => {
  const raw = localStorage.getItem(POPUP_CONFIG_KEY);
  if (!raw) return;

  let cfg: PopupConfig;
  try {
    cfg = JSON.parse(raw) as PopupConfig;
  } catch {
    return;
  }

  if (!cfg.clientId) return;

  const client = new PublicClientApplication({
    auth: {
      clientId: cfg.clientId,
      authority: cfg.authority,
      redirectUri: `${window.location.origin}/popup.html`,
    },
      cache: { cacheLocation: 'localStorage' },
  });

  await client.initialize();
  await client.handleRedirectPromise();
})();
