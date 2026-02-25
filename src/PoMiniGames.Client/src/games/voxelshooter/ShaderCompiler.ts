/**
 * Shader Compiler Abstraction Layer
 * Provides compatibility between WebGL (GLSL) and WebGPU (WGSL)
 * Prepares codebase for WebGPU 2025+ migration
 */

export type ShaderBackend = 'webgl' | 'webgpu';

export interface ShaderCompileOptions {
  backend: ShaderBackend;
  fallback?: ShaderBackend;
  defines?: Record<string, string>;
}

export interface CompiledShader {
  code: string;
  backend: ShaderBackend;
  defines: Record<string, string>;
}

export class ShaderCompiler {
  private static readonly DETECTED_BACKEND: ShaderBackend = this.detectBackend();

  /**
   * Detect the available shader backend at runtime
   */
  private static detectBackend(): ShaderBackend {
    // Check for WebGPU support (future-proofing)
    if ((navigator as any).gpu) {
      return 'webgpu';
    }
    // Default to WebGL (current standard)
    return 'webgl';
  }

  /**
   * Compile a shader for the specified backend
   * @param name Shader name for debugging
   * @param code GLSL source code (primary format)
   * @param options Compilation options
   * @returns Compiled shader with backend info
   */
  public static compile(
    name: string,
    code: string,
    options: ShaderCompileOptions
  ): CompiledShader {
    const backend = options.backend || this.DETECTED_BACKEND;
    const defines = options.defines || {};

    // Inject defines as preprocessor directives
    let finalCode = code;
    if (Object.keys(defines).length > 0) {
      const defineLines = Object.entries(defines)
        .map(([key, value]) => `#define ${key} ${value}`)
        .join('\n');
      finalCode = `${defineLines}\n${code}`;
    }

    // Future: Convert GLSL to WGSL for WebGPU backend
    if (backend === 'webgpu') {
      console.warn(
        `[ShaderCompiler] WebGPU shader requested for "${name}". ` +
        `Using GLSL fallback. Full WebGPU support coming 2025+.`
      );
    }

    return {
      code: finalCode,
      backend: backend,
      defines: defines
    };
  }

  /**
   * Get current shader backend
   */
  public static getBackend(): ShaderBackend {
    return this.DETECTED_BACKEND;
  }

  /**
   * Convert GLSL to WGSL (placeholder for 2025 WebGPU migration)
   * @param glsl GLSL source code
   * @returns WGSL source code (currently returns original for fallback)
   */
  public static glslToWgsl(glsl: string): string {
    // TODO: Implement full GLSL -> WGSL transpiler
    // For now, return GLSL as-is (WebGL is primary target)
    console.warn('[ShaderCompiler] GLSL to WGSL conversion not yet implemented');
    return glsl;
  }

  /**
   * Check if backend supports specific feature
   */
  public static supportsFeature(backend: ShaderBackend, feature: string): boolean {
    const features: Record<ShaderBackend, Set<string>> = {
      webgl: new Set(['textures', 'compute', 'shadows', 'postprocessing']),
      webgpu: new Set(['textures', 'compute', 'compute-indirect', 'raytracing', 'workgroups'])
    };

    return features[backend]?.has(feature) ?? false;
  }
}

/**
 * Helper function to easily compile voxel simulation shaders
 */
export const createVoxelShaders = () => {
  const options: ShaderCompileOptions = {
    backend: ShaderCompiler.getBackend(),
    defines: {
      'VOXEL_SIZE': '0.45',
      'MAX_PARTICLES': '65536',
      'PHYSICS_STEPS_PER_FRAME': '1'
    }
  };

  return {
    options,
    compile: (name: string, code: string) => ShaderCompiler.compile(name, code, options)
  };
};
