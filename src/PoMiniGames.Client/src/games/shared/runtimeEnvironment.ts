const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

export function isLocalDevelopmentHost(hostname: string = window.location.hostname): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname);
}