/**
 * Graphics Quality Settings Manager
 * Allows runtime toggling between 4 quality presets via 1-4 keys
 */

export type QualityLevel = 'ultra' | 'high' | 'medium' | 'low';

export interface QualityPreset {
  ssao: boolean;
  bloom: boolean;
  csm: number;
  shadowSize: number;
  bloomRadius?: number;
  bloomStrength?: number;
  pixelRatio?: number;
}

export const QUALITY_PRESETS: Record<QualityLevel, QualityPreset> = {
  ultra: {
    ssao: true,
    bloom: true,
    csm: 1,
    shadowSize: 1024,
    bloomRadius: 0.25,
    bloomStrength: 0.8,
    pixelRatio: 2.0,
  },
  high: {
    ssao: true,
    bloom: true,
    csm: 1,
    shadowSize: 512,
    bloomRadius: 0.2,
    bloomStrength: 0.6,
    pixelRatio: 1.5,
  },
  medium: {
    ssao: false,
    bloom: true,
    csm: 1,
    shadowSize: 256,
    bloomRadius: 0.1,
    bloomStrength: 0.4,
    pixelRatio: 1.0,
  },
  low: {
    ssao: false,
    bloom: false,
    csm: 0,
    shadowSize: 0,
    bloomRadius: 0,
    bloomStrength: 0,
    pixelRatio: 1.0,
  },
};

export class QualitySettings {
  private currentLevel: QualityLevel = 'high';
  private listeners: Set<(level: QualityLevel, preset: QualityPreset) => void> = new Set();

  constructor() {
    this.setupKeyboardListeners();
  }

  private setupKeyboardListeners() {
    document.addEventListener('keydown', (event: KeyboardEvent) => {
      const keyMap: Record<string, QualityLevel> = {
        '4': 'ultra',
        '3': 'high',
        '2': 'medium',
        '1': 'low',
      };

      if (keyMap[event.key]) {
        event.preventDefault();
        this.setQuality(keyMap[event.key]);
      }
    });
  }

  public setQuality(level: QualityLevel): void {
    if (this.currentLevel === level) return;

    this.currentLevel = level;
    const preset = QUALITY_PRESETS[level];

    // Notify all listeners (UIManager, Renderer, etc.)
    this.listeners.forEach(callback => callback(level, preset));

    console.log(`[Graphics] Quality changed to ${level.toUpperCase()}`, preset);
  }

  public getQuality(): QualityLevel {
    return this.currentLevel;
  }

  public getPreset(): QualityPreset {
    return QUALITY_PRESETS[this.currentLevel];
  }

  public subscribe(callback: (level: QualityLevel, preset: QualityPreset) => void): () => void {
    this.listeners.add(callback);

    // Return unsubscribe function
    return () => {
      this.listeners.delete(callback);
    };
  }
}

export const qualitySettings = new QualitySettings();
