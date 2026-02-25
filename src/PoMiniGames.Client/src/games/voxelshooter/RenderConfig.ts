// @ts-nocheck
/**
 * Centralized Rendering Configuration
 * All visual effect parameters in one place for easy tweaking
 */
export const RENDER_CONFIG = {
  // Screen Space Ambient Occlusion
  SSAO: {
    kernelRadius: 16,
    minDistance: 0.005,
    maxDistance: 0.1
  },

  // Unreal Bloom (glowing effects)
  BLOOM: {
    threshold: 1.0,
    strength: 0.8,
    radius: 0.25
  },

  // Cascaded Shadow Maps
  CSM: {
    maxFar: 1000,
    cascades: 1,  // Simplified from 2
    shadowMapSize: 512,  // Simplified from 1024
    mode: 'practical' as const,
    lightDirection: { x: -1, y: -1.5, z: -1 }
  },

  // Mouse-based Depth of Field (DISABLED - removed for performance)
  BOKEH_ENABLED: false,

  // God Rays lens flare effect (DISABLED - removed for performance)
  GODRAY_ENABLED: false,

  // SMAA (edge anti-aliasing)
  SMAA_ENABLED: true
};
