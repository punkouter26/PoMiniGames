import { describe, expect, it } from 'vitest';
import { isLocalDevelopmentHost } from '../../games/shared/runtimeEnvironment';

describe('isLocalDevelopmentHost', () => {
  it.each(['localhost', '127.0.0.1', '::1'])('treats %s as local', (hostname) => {
    expect(isLocalDevelopmentHost(hostname)).toBe(true);
  });

  it.each(['app-5ln5hfdrvof5u.azurewebsites.net', 'pominigames.azure.com', 'example.com'])(
    'treats %s as remote',
    (hostname) => {
      expect(isLocalDevelopmentHost(hostname)).toBe(false);
    },
  );
});