import {
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
  type AuthenticationResult,
} from '@azure/msal-browser';
import { useCallback, useRef } from 'react';
import { apiService, type AuthClientConfiguration, type AuthenticatedUserProfile } from '../games/shared/apiService';
import { setStoredAccessToken } from './authStorage';

const POPUP_CONFIG_KEY = 'msal_popup_config';

export function useMsalAuth(config: AuthClientConfiguration | null) {
  const clientRef = useRef<PublicClientApplication | null>(null);
  const signingInRef = useRef(false);

  const initialize = useCallback(async (authConfig: AuthClientConfiguration): Promise<{
    user: AuthenticatedUserProfile | null;
    accessToken: string | null;
    error: string | null;
  }> => {
    if (!authConfig?.microsoftEnabled) return { user: null, accessToken: null, error: null };

    const redirectUri = new URL(authConfig.redirectPath, window.location.origin).toString();
    const client = new PublicClientApplication({
      auth: {
        clientId: authConfig.clientId,
        authority: authConfig.authority,
        redirectUri,
        postLogoutRedirectUri: window.location.origin,
      },
      cache: { cacheLocation: 'localStorage' },
    });

    await client.initialize();
    clientRef.current = client;

    try {
      const redirectResult = await client.handleRedirectPromise();
      const account =
        redirectResult?.account ??
        client.getActiveAccount() ??
        client.getAllAccounts()[0] ??
        null;

      if (!account) return { user: null, accessToken: null, error: null };

      client.setActiveAccount(account);
      return await acquireToken(client, authConfig, account, redirectResult ?? undefined);
    } catch (err) {
      return {
        user: null,
        accessToken: null,
        error: err instanceof Error ? err.message : 'Failed to initialize Microsoft sign-in.',
      };
    }
  }, []);

  const signIn = useCallback(async (): Promise<{ user: AuthenticatedUserProfile | null; accessToken: string | null; error: string | null }> => {
    if (!config?.microsoftEnabled || !clientRef.current) return { user: null, accessToken: null, error: null };
    if (signingInRef.current) return { user: null, accessToken: null, error: null };

    // Clear any stale MSAL interaction status left by a previous cancelled/failed popup
    for (const key of Object.keys(sessionStorage)) {
      if (key.includes('interaction.status')) sessionStorage.removeItem(key);
    }

    // Store config so popup-redirect.ts can initialize MSAL in the popup window
    localStorage.setItem(POPUP_CONFIG_KEY, JSON.stringify({ clientId: config.clientId, authority: config.authority }));

    signingInRef.current = true;
    try {
      const result = await clientRef.current.loginPopup({
        scopes: [config.scope],
        redirectUri: `${window.location.origin}/popup.html`,
      });
      clientRef.current.setActiveAccount(result.account);
      return acquireToken(clientRef.current, config, result.account, result);
    } finally {
      signingInRef.current = false;
    }
  }, [config]);

  const signOut = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    const account = client.getActiveAccount() ?? client.getAllAccounts()[0] ?? null;
    setStoredAccessToken(null);
    if (account) {
      await client.logoutRedirect({
        account,
        postLogoutRedirectUri: window.location.origin,
      });
    }
  }, []);

  return { initialize, signIn, signOut };
}

async function acquireToken(
  client: PublicClientApplication,
  config: AuthClientConfiguration,
  account: AccountInfo,
  redirectResult: AuthenticationResult | undefined,
): Promise<{ user: AuthenticatedUserProfile | null; accessToken: string | null; error: string | null }> {
  try {
    const tokenResult =
      redirectResult ??
      (await client.acquireTokenSilent({ account, scopes: [config.scope] }));

    setStoredAccessToken(tokenResult.accessToken);
    const user = await apiService.getAuthenticatedUser(tokenResult.accessToken);
    return { user, accessToken: tokenResult.accessToken, error: null };
  } catch (err) {
    setStoredAccessToken(null);
    const error =
      err instanceof InteractionRequiredAuthError
        ? 'Sign in is required to access online multiplayer.'
        : err instanceof Error
          ? err.message
          : 'Unable to load the signed-in Microsoft account.';
    return { user: null, accessToken: null, error };
  }
}
