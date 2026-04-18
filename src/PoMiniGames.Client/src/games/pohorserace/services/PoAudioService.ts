/**
 * PoAudioService.ts — GoF Decorator pattern wrapping Tone.js synthesisers.
 * Annotation: // GoF Decorator — wraps Tone.js synthesisers behind a
 *   domain-specific audio interface, adding logging and guard behaviour.
 *
 * IMPORTANT: init() MUST be called on the first user gesture (Web Audio API
 * autoplay policy). Before init() all methods are intentional no-ops.
 *
 * Tone.js CDN note: imported as 'tone' — bundled via Vite/npm (not CDN).
 */

import * as Tone from 'tone';
import { PoLogger } from '../utils/PoLogger';

// GoF Decorator — wraps Tone.js synthesisers behind a domain-specific audio interface.

class PoAudioServiceImpl {
  private _initialised = false;

  // Synthesiser instances (created lazily in init())
  private _rimClack: Tone.MetalSynth | null = null;
  private _rumble: Tone.NoiseSynth | null = null;
  private _winnerBell: Tone.Synth | null = null;

  /**
   * Must be called on the first user gesture before any audio will play.
   * Idempotent — safe to call more than once.
   */
  async init(): Promise<void> {
    if (this._initialised) return;

    await Tone.start();

    this._rimClack = new Tone.MetalSynth({
      envelope: { attack: 0.001, decay: 0.1, release: 0.1 },
      harmonicity: 5.1,
      modulationIndex: 32,
      resonance: 4000,
      octaves: 1.5,
    }).toDestination();
    // Set frequency via the Signal API (not constructor option in Tone.js v15)
    this._rimClack.frequency.value = 400;

    this._rumble = new Tone.NoiseSynth({
      noise: { type: 'brown' },
      envelope: { attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.1 },
    }).toDestination();

    this._winnerBell = new Tone.Synth({
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.01, decay: 0.5, sustain: 0.3, release: 1.0 },
    }).toDestination();

    this._initialised = true;
    PoLogger.log({
      timestamp: new Date().toISOString(),
      level: 'info',
      service: 'PoAudioService',
      action: 'init',
      status: 'ok',
    });
  }

  /** Play a rim-clack transient. velocity 0–1 maps to volume. */
  playRimClack(velocity: number): void {
    if (!this._initialised || !this._rimClack) return;
    const gain = Math.max(0, Math.min(1, velocity));
    this._rimClack.volume.value = Tone.gainToDb(gain);
    // MetalSynth inherits Instrument.triggerAttackRelease(note, duration, time?, velocity?)
    // The note arg is a frequency value (MetalSynth overrides it with its own freq signal).
    this._rimClack.triggerAttackRelease(400, '16n');
    PoLogger.log({
      timestamp: new Date().toISOString(),
      level: 'debug',
      service: 'PoAudioService',
      action: 'playRimClack',
      status: 'ok',
      detail: { velocity },
    });
  }

  /** Start rolling rumble proportional to ball speed. */
  playRumble(speed: number): void {
    if (!this._initialised || !this._rumble) return;
    const gain = Math.max(0, Math.min(1, speed / 28)); // 28 mph = max speed
    this._rumble.volume.value = Tone.gainToDb(Math.max(0.001, gain));
    this._rumble.triggerAttack();
    PoLogger.log({
      timestamp: new Date().toISOString(),
      level: 'debug',
      service: 'PoAudioService',
      action: 'playRumble',
      status: 'ok',
      detail: { speed },
    });
  }

  /** Stop any active rolling rumble. */
  stopRumble(): void {
    if (!this._initialised || !this._rumble) return;
    this._rumble.triggerRelease();
    PoLogger.log({
      timestamp: new Date().toISOString(),
      level: 'debug',
      service: 'PoAudioService',
      action: 'stopRumble',
      status: 'ok',
    });
  }

  /** Play the winner's bell flourish. */
  playWinnerBell(): void {
    if (!this._initialised || !this._winnerBell) return;
    const now = Tone.now();
    this._winnerBell.triggerAttackRelease('C5', '8n', now);
    this._winnerBell.triggerAttackRelease('E5', '8n', now + 0.2);
    this._winnerBell.triggerAttackRelease('G5', '8n', now + 0.4);
    this._winnerBell.triggerAttackRelease('C6', '4n', now + 0.6);
    PoLogger.log({
      timestamp: new Date().toISOString(),
      level: 'debug',
      service: 'PoAudioService',
      action: 'playWinnerBell',
      status: 'ok',
    });
  }
}

/** Exported singleton. */
export const poAudioService = new PoAudioServiceImpl();
