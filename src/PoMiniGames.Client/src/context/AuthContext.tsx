import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import {
  type AuthClientConfiguration,
  type AuthenticatedUserProfile,
  getDevUserFromUrl,
} from '../games/shared/apiService';
import { apiService } from '../games/shared/apiService';
import {
  consumePendingReturnUrl,
  setStoredAccessToken,
} from './authStorage';
import { useDevAuth } from './useDevAuth';
import { useMsalAuth } from './useMsalAuth';

interface AuthContextType {
  config: AuthClientConfiguration | null;
  user: AuthenticatedUserProfile | null;
  accessToken: string | null;
  isConfigured: boolean;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  signIn: () => Promise<AuthenticatedUserProfile | null>;
  /** Developer Bypass: no login call — server auto-authenticates via DevBypassAuthHandler. Dev-only. */
  devBypass: () => Promise<AuthenticatedUserProfile | null>;
  signOut: () => Promise<void>;
  consumeReturnUrl: () => string | null;
}

const AuthContext = createContext<AuthContextType>({
  config: null,
  user: null,
  accessToken: null,
  isConfigured: false,
  isAuthenticated: false,
  isLoading: true,
  error: null,
  signIn: async () => null,
  devBypass: async () => null,
  signOut: async () => {},
  consumeReturnUrl: () => null,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AuthClientConfiguration | null>(null);
  const [user, setUser] = useState<AuthenticatedUserProfile | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const msalAuth = useMsalAuth(config);
  const devAuth = useDevAuth(config);

  useEffect(() => {
    let cancelled = false;

    async function initializeAuth() {
      setIsLoading(true);
      setError(null);

      const authConfig = await apiService.getAuthConfiguration();
      if (cancelled) return;

      setConfig(authConfig);
      if (!authConfig || !authConfig.enabled) {
        setStoredAccessToken(null);
        setAccessToken(null);
        setUser(null);
        setIsLoading(false);
        return;
      }

      if (!authConfig.microsoftEnabled && authConfig.devLoginEnabled) {
        setStoredAccessToken(null);
        setAccessToken(null);

        // If ?user=Name is in the URL, auto-create a cookie session for that
        // identity so two tabs with different ?user= params act as different
        // players (no manual button click required).
        const urlUser = getDevUserFromUrl();
        const profile = urlUser
          ? await apiService.devBypass(urlUser)
          : await devAuth.getUser();
        if (cancelled) return;

        setUser(profile);
        setIsLoading(false);
        return;
      }

      try {
      const { user: msalUser, accessToken: msalToken, error: msalError } = await msalAuth.initialize(authConfig);
        if (!cancelled) {
          setUser(msalUser);
          setAccessToken(msalToken);
          setError(msalError);
          if (!msalUser) setStoredAccessToken(null);
        }
      } catch (authError) {
        if (!cancelled) setError(authError instanceof Error ? authError.message : 'Failed to initialize Microsoft sign-in.');
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void initializeAuth();

    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const signIn = async (): Promise<AuthenticatedUserProfile | null> => {
    if (!config?.enabled) {
      return null;
    }

    if (config.microsoftEnabled) {
      const { user: msalUser, accessToken: msalToken, error: msalError } = await msalAuth.signIn();
      if (msalError) setError(msalError);
      if (msalUser) {
        setError(null);
        setUser(msalUser);
        setAccessToken(msalToken);
      }
      return msalUser;
    }

    if (config.devLoginEnabled) {
      const profile = await devAuth.login();
      if (profile) {
        setError(null);
        setAccessToken(null);
        setUser(profile);
        return profile;
      } else {
        setError('Failed to create local dev-login session.');
      }
    }

    return null;
  };

  /**
   * Developer Bypass — creates a cookie session using the ?user= URL param.
   * localhost:5173/?user=Alice  →  authenticated as Alice.
   * No ?user= param             →  authenticated as "Dev Admin".
   * Only active in Development (devLoginEnabled).
   */
  const devBypass = async (): Promise<AuthenticatedUserProfile | null> => {
    if (!config?.devLoginEnabled) {
      setError('Developer Bypass is not available outside Development.');
      return null;
    }
    const profile = await apiService.devBypass();
    if (profile) {
      setError(null);
      setAccessToken(null);
      setUser(profile);
      return profile;
    }
    setError('Developer Bypass failed — server did not return a user profile.');
    return null;
  };

  const signOut = async () => {
    setStoredAccessToken(null);
    setAccessToken(null);
    setUser(null);

    if (config?.devLoginEnabled) {
      await devAuth.logout();
      return;
    }

    await msalAuth.signOut();
  };

  return (
    <AuthContext.Provider
      value={{
        config,
        user,
        accessToken,
        isConfigured: Boolean(config?.enabled),
        isAuthenticated: Boolean(user),
        isLoading,
        error,
        signIn,
        devBypass,
        signOut,
        consumeReturnUrl: consumePendingReturnUrl,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

