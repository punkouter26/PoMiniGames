import { useCallback } from 'react';
import { apiService, type AuthClientConfiguration, type AuthenticatedUserProfile, type DevLoginRequest } from '../games/shared/apiService';
import { setStoredAccessToken } from './authStorage';

export function useDevAuth(config: AuthClientConfiguration | null) {
  const login = useCallback(
    async (request?: DevLoginRequest): Promise<AuthenticatedUserProfile | null> => {
      if (!config?.devLoginEnabled) return null;
      const profile = await apiService.devLogin(request);
      if (profile) setStoredAccessToken(null);
      return profile;
    },
    [config],
  );

  const logout = useCallback(async () => {
    await apiService.devLogout();
  }, []);

  const getUser = useCallback(async () => {
    return apiService.getAuthenticatedUser();
  }, []);

  return { login, logout, getUser };
}
