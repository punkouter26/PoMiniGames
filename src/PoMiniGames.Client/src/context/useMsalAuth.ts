import {
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
  type AuthenticationResult,
} from '@azure/msal-browser';
import { useCallback, useRef } from 'react';
import { apiService, type AuthClientConfiguration, type AuthenticatedUserProfile } from '../games/shared/apiService';
import { setPendingReturnUrl, setStoredAccessToken } from './authStorage';

export function useMsalAuth(config: AuthClientConfiguration | null) {
  const clientRef = useRef<PublicClientApplication | null>(null);

  const initialize = useCallback(async (): Promise<{
    user: AuthenticatedUserProfile | null;
    accessToken: string | null;
    error: string | null;
  }> => {
    if (!config?.microsoftEnabled) return { user: null, accessToken: null, error: null };

    const redirectUri = new URL(config.redirectPath, window.location.origin).toString();
    const client = new PublicClientApplication({
      auth: {
        clientId: config.clientId,
        authority: config.authority,
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
      return await acquireToken(client, config, account, redirectResult ?? undefined);
    } catch (err) {
      return {
        user: null,
        accessToken: null,
        error: err instanceof Error ? err.message : 'Failed to initialize Microsoft sign-in.',
      };
    }
  }, [config]);

  const signIn = useCallback(async () => {
    if (!config?.microsoftEnabled || !clientRef.current) return;
    setPendingReturnUrl(`${window.location.pathname}${window.location.search}`);
    await clientRef.current.loginRedirect({
      scopes: [config.scope],
      redirectUri: new URL(config.redirectPath, window.location.origin).toString(),
    });
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
