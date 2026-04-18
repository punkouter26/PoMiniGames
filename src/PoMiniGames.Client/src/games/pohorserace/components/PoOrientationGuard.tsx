/**
 * PoOrientationGuard.tsx — Landscape orientation block overlay.
 *
 * Subscribes to window.screen.orientation change events.
 * In landscape: renders a full-viewport HTML overlay (via @react-three/drei <Html>)
 * asking the user to rotate their device.
 * In portrait: renders null (no 3D child is blocked).
 *
 * Must be mounted inside a three.js <Canvas> context (drei Html requires it).
 */

import type { JSX } from 'react';
import { useState, useEffect } from 'react';
import { Html } from '@react-three/drei';

/** True only on touch-capable mobile/tablet devices (not desktop browsers). */
function isMobileDevice(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(pointer: coarse)').matches
  );
}

function isLandscape(): boolean {
  // Only enforce portrait lock on touchscreen devices.
  // Desktop browsers are always wide — skip the guard.
  if (!isMobileDevice()) return false;

  if (typeof window.screen.orientation !== 'undefined') {
    return window.screen.orientation.type.startsWith('landscape');
  }
  return window.innerWidth > window.innerHeight;
}

export function PoOrientationGuard(): JSX.Element | null {
  const [landscape, setLandscape] = useState(isLandscape);

  useEffect(() => {
    // T059: Request OS-level portrait lock on mount (FR-016).
    // Silently ignored on desktop browsers that don't support the API.
    // Type cast needed — ScreenOrientation.lock is Stage 2 and missing from older TS DOM typings.
    const orientationLock = (window.screen?.orientation as unknown as { lock?: (o: string) => Promise<void> })?.lock;
    if (typeof orientationLock === 'function') {
      orientationLock.call(window.screen.orientation, 'portrait-primary')
        .catch(() => { /* unsupported — CSS fallback active */ });
    }

    const handler = (): void => setLandscape(isLandscape());

    if (typeof window.screen.orientation !== 'undefined') {
      window.screen.orientation.addEventListener('change', handler);
    } else {
      window.addEventListener('resize', handler);
    }

    return () => {
      if (typeof window.screen.orientation !== 'undefined') {
        window.screen.orientation.removeEventListener('change', handler);
      } else {
        window.removeEventListener('resize', handler);
      }
    };
  }, []);

  if (!landscape) return null;

  return (
    <Html fullscreen zIndexRange={[9999, 9999]}>
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(0,0,0,0.88)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          color: '#fff',
          fontSize: '1.4rem',
          textAlign: 'center',
          padding: '2rem',
          zIndex: 9999,
        }}
      >
        <span>📱 Please rotate your device to portrait mode</span>
      </div>
    </Html>
  );
}
