import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, any>;

function buildTubeGeometry(
  path: { points: [number, number, number][]; radius?: number; radialSegments?: number; closed?: boolean },
): THREE.TubeGeometry {
  const vectors = path.points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const curve = new THREE.CatmullRomCurve3(vectors, path.closed ?? false);
  const tubularSegments = Math.max(8, path.points.length * 6);
  return new THREE.TubeGeometry(curve, tubularSegments, path.radius ?? 0.05, path.radialSegments ?? 8, path.closed ?? false);
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [clampAlbedoChannel((value >> 16) & 255), clampAlbedoChannel((value >> 8) & 255), clampAlbedoChannel(value & 255)];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampAlbedoChannel(value: number): number {
  return Math.max(30, Math.min(240, Math.round(value)));
}

function clampPbrF0(value: number): number {
  return Math.max(0.02, Math.min(1, value));
}

function clampPbrIor(value: number): number {
  return Math.max(1, Math.min(2.5, value));
}

function clampPbrMetalness(value: number): number {
  return value >= 0.5 ? 1 : 0;
}

function clampedAlbedoColor(spec: SculptMaterialSpec): THREE.Color {
  const source = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  // setStyle with an explicit SRGBColorSpace, NOT the numeric constructor.
  //
  // `new THREE.Color(r, g, b)` treats its arguments as LINEAR working-space components,
  // while an authored `baseColor` hex is sRGB. Feeding one to the other skipped the
  // transfer function and lifted every dark albedo: #2e2a28, authored as a near-black
  // vinyl, rendered at roughly sRGB 0.46 — a mid grey. The error is largest exactly where
  // it matters most, because the transfer curve is steepest near black.
  return new THREE.Color().setStyle(source, THREE.SRGBColorSpace);
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [clampAlbedoChannel(Number(match[1])), clampAlbedoChannel(Number(match[2])), clampAlbedoChannel(Number(match[3]))];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions, denseComponent = false): THREE.MeshPhysicalMaterial {
  // A material that declares -- with evidence -- that its subject carries no texture
  // detail gets NO texture set. Synthesising one anyway is not a harmless default: the
  // branch below then forces color to white and roughness to 1 and reads both from the
  // generated maps, so the authored albedo and the reference-derived roughness are both
  // discarded, and the model gains mottling the reference does not have. Measured on the
  // tuxedo cat, whose black fur rendered as speckled grey-and-white from a palette that
  // only ever described two flat regions.
  const textureless = (spec.textureless as { declared?: boolean } | undefined)?.declared === true;
  const textures = textureless
    ? null
    : makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : clampedAlbedoColor(spec),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clampPbrMetalness(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: clampPbrIor(readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: clampPbrIor(readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clampPbrF0(readLayerNumber(spec.specularF0 ?? spec.f0 ?? spec.specularIntensity, ['base', 'value'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
    flatShading: spec.flatShading === true,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const denseMesh = denseComponent || spec.denseMesh === true || spec.geometryDensity === 'dense' || spec.topologyClass === 'dense';
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    const effectiveBumpScale = denseMesh ? Math.max(0.05, bumpScale) : bumpScale;
    if (effectiveBumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = effectiveBumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    const effectiveDisplacementScale = denseMesh ? Math.max(0.005, displacementScale) : displacementScale;
    if (effectiveDisplacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = effectiveDisplacementScale;
      material.displacementBias = -effectiveDisplacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrConstraints = { albedoRange: [30, 240], binaryMetalness: true, f0Range: [0.02, 1], iorRange: [1, 2.5] };
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.userData.referenceMaterialId = spec.referenceMaterialId ?? spec.materialReference?.profileId ?? null;
  material.userData.materialEvidence = spec.materialEvidence ?? null;
  material.userData.validationViews = spec.materialReference?.validationViews ?? [];
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: Navy upholstered chair
// Sculpt build pass: optimization-pass
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createNavyUpholsteredChairModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Navy upholstered chair";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 40.0, "aspect": 1.0, "orientation": {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}, "positionHint": [0.0, 0.0, 3.0], "note": "For likeness work, solve the reference camera (forge/stage1_intake/solve_camera_pose.py) so the review render aligns with the photo and the reference can be projected. Confirm by overlay review."}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["upholstery"] = createSculptMaterial(
    "upholstery",
    {"id": "upholstery", "kind": "fabric-upholstery", "channels": {"albedo": {"color": "#1c2c52", "intensity": 1.0, "secondary": "rgba(20, 32, 60, 1.0)"}, "metalness": 0.0, "normalScale": [0.4, 0.4]}, "colorVariation": {"range": ["#1c2c52", "#14203c"], "palette": ["#1c2c52", "#14203c", "#233a6b"], "amplitude": 0.05, "evidenceRef": "seat-front-bevel-detail", "notes": "Subtle ambient-occlusion variation across the fabric, not a distinct hue."}, "roughness": {"base": 0.85, "variation": 0.05, "map": "C:\\Users\\punko\\Downloads\\pominigames\\.img2threejs\\pbr-extracted\\upholstery_roughness.png"}, "normal": {"strength": 0.4}, "bump": {"amplitude": 0.35, "map": "C:\\Users\\punko\\Downloads\\pominigames\\.img2threejs\\pbr-extracted\\upholstery_height.png"}, "ambientOcclusion": {"map": "C:\\Users\\punko\\Downloads\\pominigames\\.img2threejs\\pbr-extracted\\upholstery_ao.png", "intensity": 0.4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.5, "amplitude": 0.001, "type": "dye-uniform"}, {"id": "meso", "frequency": 8.0, "amplitude": 0.0008, "type": "fabric-weave-noise"}, {"id": "micro", "frequency": 50.0, "amplitude": 0.0003, "type": "fiber-relief-noise"}], "textureProjection": {"mode": "triplanar", "texelDensity": 1024}, "textureResolution": 1024, "referencePbr": {"version": "v1", "sourceImage": "C:\\Users\\punko\\Downloads\\pominigames\\src\\PoMiniGames.Client\\wwwroot\\games\\pogallery\\refs\\chair.png", "extractor": "forge/stage1_intake/extract_pbr_evidence.py", "method": "inferred-from-uniform-dye", "verdict": "pass-with-caveat", "hardLimit": "single view; solid-color upholstery: a single dominant navy dye; no pattern to project.", "usable": true, "confidence": 0.7, "estimatedFidelity": 0.7, "targetThreshold": 0.7, "maps": {"albedo": {"path": "C:\\Users\\punko\\Downloads\\pominigames\\.img2threejs\\pbr-extracted\\upholstery_albedo.png"}, "roughness": {"path": "C:\\Users\\punko\\Downloads\\pominigames\\.img2threejs\\pbr-extracted\\upholstery_roughness.png"}, "height": {"path": "C:\\Users\\punko\\Downloads\\pominigames\\.img2threejs\\pbr-extracted\\upholstery_height.png"}, "normal": {"path": "C:\\Users\\punko\\Downloads\\pominigames\\.img2threejs\\pbr-extracted\\upholstery_normal.png"}, "ao": {"path": "C:\\Users\\punko\\Downloads\\pominigames\\.img2threejs\\pbr-extracted\\upholstery_ao.png"}}}, "localOverrides": [{"id": "upholstery.weaveMicro", "kind": "roughness-variation", "evidenceRef": "seat-front-bevel-detail", "params": {"amplitude": 0.05, "scale": 0.005}, "confidence": 0.6}], "evidenceRefs": ["seat-front-bevel-detail"]},
    options
  );
  materialMap["frame"] = createSculptMaterial(
    "frame",
    {"id": "frame", "kind": "brushed-steel", "channels": {"albedo": {"color": "#b8b8b8", "intensity": 1.0, "secondary": "rgba(150, 150, 150, 1.0)"}, "metalness": 0.85, "clearcoat": 0.4, "clearcoatRoughness": 0.15, "anisotropy": 0.7, "anisotropyRotation": 0.0, "envMapIntensity": 1.0}, "colorVariation": {"range": ["#b8b8b8", "#d4d4d4", "#9c9c9c"], "palette": ["#b8b8b8", "#d4d4d4", "#9c9c9c"], "amplitude": 0.08, "evidenceRef": "frame-detail", "notes": "Anisotropic vertical brushing produces per-leg highlight shifts along the brushed direction."}, "roughness": {"base": 0.3, "variation": 0.05, "map": "C:\\Users\\punko\\Downloads\\pominigames\\.img2threejs\\pbr-extracted\\frame_roughness.png"}, "normal": {"strength": 0.2}, "bump": {"amplitude": 0.15, "map": "C:\\Users\\punko\\Downloads\\pominigames\\.img2threejs\\pbr-extracted\\frame_height.png"}, "ambientOcclusion": {"map": "C:\\Users\\punko\\Downloads\\pominigames\\.img2threejs\\pbr-extracted\\frame_ao.png", "intensity": 0.6}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.5, "amplitude": 0.001, "type": "uniform-albedo"}, {"id": "meso", "frequency": 16.0, "amplitude": 0.0008, "type": "vertical-brushing-anisotropy"}, {"id": "micro", "frequency": 80.0, "amplitude": 0.0003, "type": "polish-noise"}], "textureProjection": {"mode": "cylindrical", "texelDensity": 1024}, "textureResolution": 1024, "referencePbr": {"version": "v1", "sourceImage": "C:\\Users\\punko\\Downloads\\pominigames\\src\\PoMiniGames.Client\\wwwroot\\games\\pogallery\\refs\\chair.png", "extractor": "forge/stage1_intake/extract_pbr_evidence.py", "method": "inferred-from-leg-highlights", "verdict": "pass-with-caveat", "hardLimit": "single view; metalness/roughness inferred from observed highlight shape.", "usable": true, "confidence": 0.75, "estimatedFidelity": 0.75, "targetThreshold": 0.7, "maps": {"albedo": {"path": "C:\\Users\\punko\\Downloads\\pominigames\\.img2threejs\\pbr-extracted\\frame_albedo.png"}, "roughness": {"path": "C:\\Users\\punko\\Downloads\\pominigames\\.img2threejs\\pbr-extracted\\frame_roughness.png"}, "height": {"path": "C:\\Users\\punko\\Downloads\\pominigames\\.img2threejs\\pbr-extracted\\frame_height.png"}, "normal": {"path": "C:\\Users\\punko\\Downloads\\pominigames\\.img2threejs\\pbr-extracted\\frame_normal.png"}, "ao": {"path": "C:\\Users\\punko\\Downloads\\pominigames\\.img2threejs\\pbr-extracted\\frame_ao.png"}}}, "localOverrides": [{"id": "frame.brushedAnisotropy", "kind": "anisotropic-roughness", "evidenceRef": "frame-detail", "params": {"direction": "vertical", "intensity": 0.7}, "confidence": 0.65}], "evidenceRefs": ["frame-detail"]},
    options
  );
  materialMap["glides"] = createSculptMaterial(
    "glides",
    {"id": "glides", "kind": "matte-plastic", "channels": {"albedo": {"color": "#1a1a1a", "intensity": 1.0, "secondary": "rgba(0, 0, 0, 1.0)"}, "metalness": 0.0}, "colorVariation": {"range": ["#1a1a1a", "#262626"], "palette": ["#1a1a1a", "#262626"], "amplitude": 0.03, "evidenceRef": "glides-detail", "notes": "Very subtle plastic fade across each glide."}, "roughness": {"base": 0.9, "variation": 0.02, "map": "C:\\Users\\punko\\Downloads\\pominigames\\.img2threejs\\pbr-extracted\\glides_roughness.png"}, "normal": {"strength": 0.1}, "bump": {"amplitude": 0.08, "map": "C:\\Users\\punko\\Downloads\\pominigames\\.img2threejs\\pbr-extracted\\glides_height.png"}, "ambientOcclusion": {"map": "C:\\Users\\punko\\Downloads\\pominigames\\.img2threejs\\pbr-extracted\\glides_ao.png", "intensity": 0.5}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.5, "amplitude": 0.001, "type": "uniform-albedo"}, {"id": "meso", "frequency": 4.0, "amplitude": 0.0005, "type": "subtle-fade"}, {"id": "micro", "frequency": 60.0, "amplitude": 0.0002, "type": "matte-noise"}], "textureProjection": {"mode": "cylindrical", "texelDensity": 1024}, "textureResolution": 1024, "referencePbr": {"version": "v1", "sourceImage": "C:\\Users\\punko\\Downloads\\pominigames\\src\\PoMiniGames.Client\\wwwroot\\games\\pogallery\\refs\\chair.png", "extractor": "forge/stage1_intake/extract_pbr_evidence.py", "method": "inferred-from-dark-floor-contact", "verdict": "pass-with-caveat", "hardLimit": "single view; glides inferred from floor-contact dark spots.", "usable": true, "confidence": 0.7, "estimatedFidelity": 0.7, "targetThreshold": 0.7, "maps": {"albedo": {"path": "C:\\Users\\punko\\Downloads\\pominigames\\.img2threejs\\pbr-extracted\\glides_albedo.png"}, "roughness": {"path": "C:\\Users\\punko\\Downloads\\pominigames\\.img2threejs\\pbr-extracted\\glides_roughness.png"}, "height": {"path": "C:\\Users\\punko\\Downloads\\pominigames\\.img2threejs\\pbr-extracted\\glides_height.png"}, "normal": {"path": "C:\\Users\\punko\\Downloads\\pominigames\\.img2threejs\\pbr-extracted\\glides_normal.png"}, "ao": {"path": "C:\\Users\\punko\\Downloads\\pominigames\\.img2threejs\\pbr-extracted\\glides_ao.png"}}}, "evidenceRefs": ["glides-detail"]},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const endpoint_root_0 = makeAttachmentEndpoint(null);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "root__pivot";
  node_root_0.scale.set(1, 1, 1);
  if (endpoint_root_0) {
    node_root_0.position.copy(endpoint_root_0.start);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_root_0.position.set(0.0, 0.0, 0.0);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_root_0.userData.sculptComponent = {"id": "root", "parent": null, "primitive": "box", "level": "macro", "topologyClass": "assembled-solid", "topologyRationale": "Three macro assemblies grouped under a single pivot.", "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0]}, "geometry": {"primitive": "box", "size": [1.0, 1.6, 1.0], "notes": "Bounding box; children render on top."}, "dimensions": {"width": 1.0, "height": 1.6, "depth": 1.0}, "materialIds": [], "material": "upholstery", "actionProfile": {"animationRole": "static-prop", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [1.0, 1.6, 1.0], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "root"}}, "evidenceRefs": ["full-object"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(0,0,0,0.0)", "secondaryAlbedo": "rgba(0,0,0,0.0)", "materialClass": "unknown", "materialClassConfidence": 0.0, "primaryMaterialId": ""}};
  node_root_0.userData.actionProfile = {"animationRole": "static-prop", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [1.0, 1.6, 1.0], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "root"}};
  (nodes["root"] ?? root).add(node_root_0);
  nodes["root"] = node_root_0;
  const mesh_root_0Geometry = endpoint_root_0
    ? new THREE.CylinderGeometry(endpoint_root_0.endRadius, endpoint_root_0.baseRadius, endpoint_root_0.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_root_0) {
    mesh_root_0Geometry.scale(1.0, 1.6, 1.0);
  }
  const mesh_root_0 = new THREE.Mesh(
    mesh_root_0Geometry,
    materialMap["upholstery"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_0.name = "root";
  if (endpoint_root_0) {
    mesh_root_0.position.copy(endpoint_root_0.midpoint);
    mesh_root_0.quaternion.copy(endpoint_root_0.quaternion);
  }
  mesh_root_0.castShadow = options.castShadow ?? true;
  mesh_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_root_0.userData.sculptComponent = {"id": "root", "parent": null, "primitive": "box", "level": "macro", "topologyClass": "assembled-solid", "topologyRationale": "Three macro assemblies grouped under a single pivot.", "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0]}, "geometry": {"primitive": "box", "size": [1.0, 1.6, 1.0], "notes": "Bounding box; children render on top."}, "dimensions": {"width": 1.0, "height": 1.6, "depth": 1.0}, "materialIds": [], "material": "upholstery", "actionProfile": {"animationRole": "static-prop", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [1.0, 1.6, 1.0], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "root"}}, "evidenceRefs": ["full-object"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(0,0,0,0.0)", "secondaryAlbedo": "rgba(0,0,0,0.0)", "materialClass": "unknown", "materialClassConfidence": 0.0, "primaryMaterialId": ""}};
  node_root_0.add(mesh_root_0);
  meshes["root"] = mesh_root_0;
  colliders["root"] = {"type": "box", "size": [1.0, 1.6, 1.0], "isTrigger": false};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_root_0);

  const endpoint_backrest_1 = makeAttachmentEndpoint(null);
  const node_backrest_1 = new THREE.Group();
  node_backrest_1.name = "backrest__pivot";
  node_backrest_1.scale.set(1, 1, 1);
  if (endpoint_backrest_1) {
    node_backrest_1.position.copy(endpoint_backrest_1.start);
    node_backrest_1.rotation.set(-0.12, 0.0, 0.0);
  } else {
    node_backrest_1.position.set(0.0, 0.775, -0.26);
    node_backrest_1.rotation.set(-0.12, 0.0, 0.0);
  }
  node_backrest_1.userData.sculptComponent = {"id": "backrest", "parent": "root", "primitive": "box", "level": "macro", "topologyClass": "conforming-shell", "topologyRationale": "Rectangular backrest with horizontal seam at mid-height. Sits on the seat's rear edge (seat top y=0.50), leaning slightly back.", "transform": {"position": [0, 0.775, -0.26], "rotation": [-0.12, 0, 0]}, "geometry": {"primitive": "box", "size": [0.55, 0.55, 0.05]}, "dimensions": {"width": 0.55, "height": 0.55, "depth": 0.05}, "materialIds": ["upholstery"], "material": "upholstery", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0.275, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.55, 0.55, 0.05], "isTrigger": false}, "destruction": {"breakable": true, "fractureGroup": "backrest-shell"}}, "evidenceRefs": ["backrest-seam-detail"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(28, 44, 82, 1.0)", "secondaryAlbedo": "rgba(20, 32, 60, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "primaryMaterialId": "upholstery"}, "attachment": {"parentSocket": "backrest-mount", "localStart": [0, -0.275, 0], "localEnd": [0, 0.275, 0], "contactType": "butt", "embedDepth": 0.025, "overlap": 0.02, "gapTolerance": 0.0}, "localFeatures": [{"id": "backrest.seam", "description": "Horizontal seam strip embedded at mid-height of backrest.", "evidenceRef": "backrest-seam-detail", "kind": "seam", "confidence": 0.9}]};
  node_backrest_1.userData.actionProfile = {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0.275, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.55, 0.55, 0.05], "isTrigger": false}, "destruction": {"breakable": true, "fractureGroup": "backrest-shell"}};
  (nodes["root"] ?? root).add(node_backrest_1);
  nodes["backrest"] = node_backrest_1;
  const mesh_backrest_1Geometry = endpoint_backrest_1
    ? new THREE.CylinderGeometry(endpoint_backrest_1.endRadius, endpoint_backrest_1.baseRadius, endpoint_backrest_1.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_backrest_1) {
    mesh_backrest_1Geometry.scale(0.55, 0.55, 0.05);
  }
  const mesh_backrest_1 = new THREE.Mesh(
    mesh_backrest_1Geometry,
    materialMap["upholstery"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_backrest_1.name = "backrest";
  if (endpoint_backrest_1) {
    mesh_backrest_1.position.copy(endpoint_backrest_1.midpoint);
    mesh_backrest_1.quaternion.copy(endpoint_backrest_1.quaternion);
  }
  mesh_backrest_1.castShadow = options.castShadow ?? true;
  mesh_backrest_1.receiveShadow = options.receiveShadow ?? true;
  mesh_backrest_1.userData.sculptComponent = {"id": "backrest", "parent": "root", "primitive": "box", "level": "macro", "topologyClass": "conforming-shell", "topologyRationale": "Rectangular backrest with horizontal seam at mid-height. Sits on the seat's rear edge (seat top y=0.50), leaning slightly back.", "transform": {"position": [0, 0.775, -0.26], "rotation": [-0.12, 0, 0]}, "geometry": {"primitive": "box", "size": [0.55, 0.55, 0.05]}, "dimensions": {"width": 0.55, "height": 0.55, "depth": 0.05}, "materialIds": ["upholstery"], "material": "upholstery", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0.275, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.55, 0.55, 0.05], "isTrigger": false}, "destruction": {"breakable": true, "fractureGroup": "backrest-shell"}}, "evidenceRefs": ["backrest-seam-detail"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(28, 44, 82, 1.0)", "secondaryAlbedo": "rgba(20, 32, 60, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "primaryMaterialId": "upholstery"}, "attachment": {"parentSocket": "backrest-mount", "localStart": [0, -0.275, 0], "localEnd": [0, 0.275, 0], "contactType": "butt", "embedDepth": 0.025, "overlap": 0.02, "gapTolerance": 0.0}, "localFeatures": [{"id": "backrest.seam", "description": "Horizontal seam strip embedded at mid-height of backrest.", "evidenceRef": "backrest-seam-detail", "kind": "seam", "confidence": 0.9}]};
  node_backrest_1.add(mesh_backrest_1);
  meshes["backrest"] = mesh_backrest_1;
  colliders["backrest"] = {"type": "box", "size": [0.55, 0.55, 0.05], "isTrigger": false};
  destructionGroups["backrest-shell"] ??= [];
  destructionGroups["backrest-shell"].push(node_backrest_1);

  const endpoint_seat_2 = makeAttachmentEndpoint(null);
  const node_seat_2 = new THREE.Group();
  node_seat_2.name = "seat__pivot";
  node_seat_2.scale.set(1, 1, 1);
  if (endpoint_seat_2) {
    node_seat_2.position.copy(endpoint_seat_2.start);
    node_seat_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seat_2.position.set(0.0, 0.45, 0.0);
    node_seat_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_seat_2.userData.sculptComponent = {"id": "seat", "parent": "root", "primitive": "box", "level": "macro", "topologyClass": "conforming-shell", "topologyRationale": "Cuboid cushion with rounded front bevel.", "transform": {"position": [0, 0.45, 0], "rotation": [0, 0, 0]}, "geometry": {"primitive": "box", "size": [0.55, 0.1, 0.55]}, "dimensions": {"width": 0.55, "height": 0.1, "depth": 0.55}, "materialIds": ["upholstery"], "material": "upholstery", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.55, 0.1, 0.55], "isTrigger": false}, "destruction": {"breakable": true, "fractureGroup": "seat-shell"}}, "evidenceRefs": ["seat-front-bevel-detail"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(28, 44, 82, 1.0)", "secondaryAlbedo": "rgba(20, 32, 60, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "primaryMaterialId": "upholstery"}, "attachment": {"parentSocket": "seat-mount", "localStart": [0, -0.05, 0], "localEnd": [0, 0.05, 0], "contactType": "overlap", "embedDepth": 0.0, "overlap": 0.02, "gapTolerance": 0.0}, "localFeatures": [{"id": "seat.frontBevel", "description": "Soft forward bevel along the seat front edge.", "evidenceRef": "seat-front-bevel-detail", "kind": "bevel", "confidence": 0.8}]};
  node_seat_2.userData.actionProfile = {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.55, 0.1, 0.55], "isTrigger": false}, "destruction": {"breakable": true, "fractureGroup": "seat-shell"}};
  (nodes["root"] ?? root).add(node_seat_2);
  nodes["seat"] = node_seat_2;
  const mesh_seat_2Geometry = endpoint_seat_2
    ? new THREE.CylinderGeometry(endpoint_seat_2.endRadius, endpoint_seat_2.baseRadius, endpoint_seat_2.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_seat_2) {
    mesh_seat_2Geometry.scale(0.55, 0.1, 0.55);
  }
  const mesh_seat_2 = new THREE.Mesh(
    mesh_seat_2Geometry,
    materialMap["upholstery"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seat_2.name = "seat";
  if (endpoint_seat_2) {
    mesh_seat_2.position.copy(endpoint_seat_2.midpoint);
    mesh_seat_2.quaternion.copy(endpoint_seat_2.quaternion);
  }
  mesh_seat_2.castShadow = options.castShadow ?? true;
  mesh_seat_2.receiveShadow = options.receiveShadow ?? true;
  mesh_seat_2.userData.sculptComponent = {"id": "seat", "parent": "root", "primitive": "box", "level": "macro", "topologyClass": "conforming-shell", "topologyRationale": "Cuboid cushion with rounded front bevel.", "transform": {"position": [0, 0.45, 0], "rotation": [0, 0, 0]}, "geometry": {"primitive": "box", "size": [0.55, 0.1, 0.55]}, "dimensions": {"width": 0.55, "height": 0.1, "depth": 0.55}, "materialIds": ["upholstery"], "material": "upholstery", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.55, 0.1, 0.55], "isTrigger": false}, "destruction": {"breakable": true, "fractureGroup": "seat-shell"}}, "evidenceRefs": ["seat-front-bevel-detail"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(28, 44, 82, 1.0)", "secondaryAlbedo": "rgba(20, 32, 60, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "primaryMaterialId": "upholstery"}, "attachment": {"parentSocket": "seat-mount", "localStart": [0, -0.05, 0], "localEnd": [0, 0.05, 0], "contactType": "overlap", "embedDepth": 0.0, "overlap": 0.02, "gapTolerance": 0.0}, "localFeatures": [{"id": "seat.frontBevel", "description": "Soft forward bevel along the seat front edge.", "evidenceRef": "seat-front-bevel-detail", "kind": "bevel", "confidence": 0.8}]};
  node_seat_2.add(mesh_seat_2);
  meshes["seat"] = mesh_seat_2;
  colliders["seat"] = {"type": "box", "size": [0.55, 0.1, 0.55], "isTrigger": false};
  destructionGroups["seat-shell"] ??= [];
  destructionGroups["seat-shell"].push(node_seat_2);

  const endpoint_frame_3 = makeAttachmentEndpoint(null);
  const node_frame_3 = new THREE.Group();
  node_frame_3.name = "frame__pivot";
  node_frame_3.scale.set(1, 1, 1);
  if (endpoint_frame_3) {
    node_frame_3.position.copy(endpoint_frame_3.start);
    node_frame_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_frame_3.position.set(0.0, 0.0, 0.0);
    node_frame_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_frame_3.userData.sculptComponent = {"id": "frame", "parent": "root", "primitive": "box", "level": "macro", "topologyClass": "assembled-solid", "topologyRationale": "Sled-base frame assembly: front cross-rail + 4 vertical legs. Container node; visible geometry lives in its children.", "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0]}, "geometry": {"primitive": "box", "size": [0.55, 0.02, 0.55], "notes": "Thin plate under the seat; children carry the visible tubes."}, "dimensions": {"width": 0.55, "height": 0.02, "depth": 0.55}, "materialIds": ["frame"], "material": "frame", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.55, 0.02, 0.55], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}}, "evidenceRefs": ["frame-detail", "glides-detail"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 184, 184, 1.0)", "secondaryAlbedo": "rgba(150, 150, 150, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "primaryMaterialId": "frame"}, "attachment": {"parentSocket": "frame-mount", "localStart": [0, -0.42, 0], "localEnd": [0, 0.42, 0.25], "contactType": "socket", "embedDepth": 0.03, "overlap": 0.02, "gapTolerance": 0.0}, "localFeatures": [{"id": "frame.sledBase", "description": "Sled-base frame: four vertical legs joined by a front cross-rail.", "evidenceRef": "frame-detail", "kind": "contour", "confidence": 0.85}, {"id": "frame.glides", "description": "Small dark plastic foot at the bottom of each leg.", "evidenceRef": "glides-detail", "kind": "ridge", "confidence": 0.9}, {"id": "frame.brushedAnisotropy", "description": "Vertical brush lines visible on each metal leg.", "evidenceRef": "frame-detail", "kind": "contour", "confidence": 0.65}]};
  node_frame_3.userData.actionProfile = {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.55, 0.02, 0.55], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}};
  (nodes["root"] ?? root).add(node_frame_3);
  nodes["frame"] = node_frame_3;
  const mesh_frame_3Geometry = endpoint_frame_3
    ? new THREE.CylinderGeometry(endpoint_frame_3.endRadius, endpoint_frame_3.baseRadius, endpoint_frame_3.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_frame_3) {
    mesh_frame_3Geometry.scale(0.55, 0.02, 0.55);
  }
  const mesh_frame_3 = new THREE.Mesh(
    mesh_frame_3Geometry,
    materialMap["frame"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_frame_3.name = "frame";
  if (endpoint_frame_3) {
    mesh_frame_3.position.copy(endpoint_frame_3.midpoint);
    mesh_frame_3.quaternion.copy(endpoint_frame_3.quaternion);
  }
  mesh_frame_3.castShadow = options.castShadow ?? true;
  mesh_frame_3.receiveShadow = options.receiveShadow ?? true;
  mesh_frame_3.userData.sculptComponent = {"id": "frame", "parent": "root", "primitive": "box", "level": "macro", "topologyClass": "assembled-solid", "topologyRationale": "Sled-base frame assembly: front cross-rail + 4 vertical legs. Container node; visible geometry lives in its children.", "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0]}, "geometry": {"primitive": "box", "size": [0.55, 0.02, 0.55], "notes": "Thin plate under the seat; children carry the visible tubes."}, "dimensions": {"width": 0.55, "height": 0.02, "depth": 0.55}, "materialIds": ["frame"], "material": "frame", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.55, 0.02, 0.55], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}}, "evidenceRefs": ["frame-detail", "glides-detail"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 184, 184, 1.0)", "secondaryAlbedo": "rgba(150, 150, 150, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "primaryMaterialId": "frame"}, "attachment": {"parentSocket": "frame-mount", "localStart": [0, -0.42, 0], "localEnd": [0, 0.42, 0.25], "contactType": "socket", "embedDepth": 0.03, "overlap": 0.02, "gapTolerance": 0.0}, "localFeatures": [{"id": "frame.sledBase", "description": "Sled-base frame: four vertical legs joined by a front cross-rail.", "evidenceRef": "frame-detail", "kind": "contour", "confidence": 0.85}, {"id": "frame.glides", "description": "Small dark plastic foot at the bottom of each leg.", "evidenceRef": "glides-detail", "kind": "ridge", "confidence": 0.9}, {"id": "frame.brushedAnisotropy", "description": "Vertical brush lines visible on each metal leg.", "evidenceRef": "frame-detail", "kind": "contour", "confidence": 0.65}]};
  node_frame_3.add(mesh_frame_3);
  meshes["frame"] = mesh_frame_3;
  colliders["frame"] = {"type": "box", "size": [0.55, 0.02, 0.55], "isTrigger": false};
  destructionGroups["frame"] ??= [];
  destructionGroups["frame"].push(node_frame_3);

  const attachment_frame_front_rail_4 = {"parentSocket": "frame-top-rail-fl", "localStart": [-0.25, 0.42, 0.25], "localEnd": [0.25, 0.42, 0.25], "contactType": "butt", "embedDepth": 0.03, "overlap": 0.02, "gapTolerance": 0.0};
  const endpoint_frame_front_rail_4 = makeAttachmentEndpoint(attachment_frame_front_rail_4);
  const node_frame_front_rail_4 = new THREE.Group();
  node_frame_front_rail_4.name = "frame-front-rail__pivot";
  node_frame_front_rail_4.scale.set(1, 1, 1);
  if (endpoint_frame_front_rail_4) {
    node_frame_front_rail_4.position.copy(endpoint_frame_front_rail_4.start);
    node_frame_front_rail_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_frame_front_rail_4.position.set(0.0, 0.42, 0.25);
    node_frame_front_rail_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_frame_front_rail_4.userData.sculptComponent = {"id": "frame-front-rail", "parent": "frame", "primitive": "tube", "level": "meso", "topologyClass": "assembled-solid", "topologyRationale": "Visible front cross-rail under seat front edge: horizontal tube spanning the two front legs.", "transform": {"position": [0, 0.42, 0.25], "rotation": [0, 0, 0]}, "geometry": {"primitive": "tube", "size": [0.5, 0.044, 0.044]}, "dimensions": {"width": 0.5, "height": 0.044, "depth": 0.044}, "materialIds": ["frame"], "material": "frame", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "capsule", "size": [0.022, 0.5], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}}, "evidenceRefs": ["frame-detail"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 184, 184, 1.0)", "secondaryAlbedo": "rgba(150, 150, 150, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "primaryMaterialId": "frame"}, "attachment": {"parentSocket": "frame-top-rail-fl", "localStart": [-0.25, 0.42, 0.25], "localEnd": [0.25, 0.42, 0.25], "contactType": "butt", "embedDepth": 0.03, "overlap": 0.02, "gapTolerance": 0.0}};
  node_frame_front_rail_4.userData.actionProfile = {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "capsule", "size": [0.022, 0.5], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}};
  (nodes["frame"] ?? root).add(node_frame_front_rail_4);
  nodes["frame-front-rail"] = node_frame_front_rail_4;
  const mesh_frame_front_rail_4Geometry = endpoint_frame_front_rail_4
    ? new THREE.CylinderGeometry(endpoint_frame_front_rail_4.endRadius, endpoint_frame_front_rail_4.baseRadius, endpoint_frame_front_rail_4.length, 8, 4)
    : buildTubeGeometry({"points": [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], "radius": 0.05, "closed": false});
  if (!endpoint_frame_front_rail_4) {
    mesh_frame_front_rail_4Geometry.scale(0.5, 0.044, 0.044);
  }
  const mesh_frame_front_rail_4 = new THREE.Mesh(
    mesh_frame_front_rail_4Geometry,
    materialMap["frame"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_frame_front_rail_4.name = "frame-front-rail";
  if (endpoint_frame_front_rail_4) {
    mesh_frame_front_rail_4.position.copy(endpoint_frame_front_rail_4.midpoint);
    mesh_frame_front_rail_4.quaternion.copy(endpoint_frame_front_rail_4.quaternion);
  }
  mesh_frame_front_rail_4.castShadow = options.castShadow ?? true;
  mesh_frame_front_rail_4.receiveShadow = options.receiveShadow ?? true;
  mesh_frame_front_rail_4.userData.sculptComponent = {"id": "frame-front-rail", "parent": "frame", "primitive": "tube", "level": "meso", "topologyClass": "assembled-solid", "topologyRationale": "Visible front cross-rail under seat front edge: horizontal tube spanning the two front legs.", "transform": {"position": [0, 0.42, 0.25], "rotation": [0, 0, 0]}, "geometry": {"primitive": "tube", "size": [0.5, 0.044, 0.044]}, "dimensions": {"width": 0.5, "height": 0.044, "depth": 0.044}, "materialIds": ["frame"], "material": "frame", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "capsule", "size": [0.022, 0.5], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}}, "evidenceRefs": ["frame-detail"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 184, 184, 1.0)", "secondaryAlbedo": "rgba(150, 150, 150, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "primaryMaterialId": "frame"}, "attachment": {"parentSocket": "frame-top-rail-fl", "localStart": [-0.25, 0.42, 0.25], "localEnd": [0.25, 0.42, 0.25], "contactType": "butt", "embedDepth": 0.03, "overlap": 0.02, "gapTolerance": 0.0}};
  node_frame_front_rail_4.add(mesh_frame_front_rail_4);
  meshes["frame-front-rail"] = mesh_frame_front_rail_4;
  colliders["frame-front-rail"] = {"type": "capsule", "size": [0.022, 0.5], "isTrigger": false};
  destructionGroups["frame"] ??= [];
  destructionGroups["frame"].push(node_frame_front_rail_4);

  const attachment_frame_leg_fl_5 = {"parentSocket": "frame-leg-socket-fl", "localStart": [-0.25, 0.42, 0.25], "localEnd": [-0.25, 0.0, 0.25], "contactType": "socket", "embedDepth": 0.025, "overlap": 0.02, "gapTolerance": 0.0};
  const endpoint_frame_leg_fl_5 = makeAttachmentEndpoint(attachment_frame_leg_fl_5);
  const node_frame_leg_fl_5 = new THREE.Group();
  node_frame_leg_fl_5.name = "frame-leg-fl__pivot";
  node_frame_leg_fl_5.scale.set(1, 1, 1);
  if (endpoint_frame_leg_fl_5) {
    node_frame_leg_fl_5.position.copy(endpoint_frame_leg_fl_5.start);
    node_frame_leg_fl_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_frame_leg_fl_5.position.set(0.0, 0.0, 0.0);
    node_frame_leg_fl_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_frame_leg_fl_5.userData.sculptComponent = {"id": "frame-leg-fl", "parent": "frame", "primitive": "tube", "level": "macro", "topologyClass": "assembled-solid", "topologyRationale": "Front-left sled leg: single tube curving from the seat rail down and back to the floor runner (cantilever approximation).", "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0]}, "geometry": {"primitive": "tube", "size": [1, 1, 1]}, "dimensions": {"width": 1, "height": 1, "depth": 1}, "materialIds": ["frame"], "material": "frame", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "capsule", "size": [0.022, 0.42], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}}, "evidenceRefs": ["frame-detail"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 184, 184, 1.0)", "secondaryAlbedo": "rgba(150, 150, 150, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "primaryMaterialId": "frame"}, "attachment": {"parentSocket": "frame-leg-socket-fl", "localStart": [-0.25, 0.42, 0.25], "localEnd": [-0.25, 0.0, 0.25], "contactType": "socket", "embedDepth": 0.025, "overlap": 0.02, "gapTolerance": 0.0}};
  node_frame_leg_fl_5.userData.actionProfile = {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "capsule", "size": [0.022, 0.42], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}};
  (nodes["frame"] ?? root).add(node_frame_leg_fl_5);
  nodes["frame-leg-fl"] = node_frame_leg_fl_5;
  const mesh_frame_leg_fl_5Geometry = endpoint_frame_leg_fl_5
    ? new THREE.CylinderGeometry(endpoint_frame_leg_fl_5.endRadius, endpoint_frame_leg_fl_5.baseRadius, endpoint_frame_leg_fl_5.length, 8, 4)
    : buildTubeGeometry({"points": [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], "radius": 0.05, "closed": false});
  if (!endpoint_frame_leg_fl_5) {
    mesh_frame_leg_fl_5Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_frame_leg_fl_5 = new THREE.Mesh(
    mesh_frame_leg_fl_5Geometry,
    materialMap["frame"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_frame_leg_fl_5.name = "frame-leg-fl";
  if (endpoint_frame_leg_fl_5) {
    mesh_frame_leg_fl_5.position.copy(endpoint_frame_leg_fl_5.midpoint);
    mesh_frame_leg_fl_5.quaternion.copy(endpoint_frame_leg_fl_5.quaternion);
  }
  mesh_frame_leg_fl_5.castShadow = options.castShadow ?? true;
  mesh_frame_leg_fl_5.receiveShadow = options.receiveShadow ?? true;
  mesh_frame_leg_fl_5.userData.sculptComponent = {"id": "frame-leg-fl", "parent": "frame", "primitive": "tube", "level": "macro", "topologyClass": "assembled-solid", "topologyRationale": "Front-left sled leg: single tube curving from the seat rail down and back to the floor runner (cantilever approximation).", "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0]}, "geometry": {"primitive": "tube", "size": [1, 1, 1]}, "dimensions": {"width": 1, "height": 1, "depth": 1}, "materialIds": ["frame"], "material": "frame", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "capsule", "size": [0.022, 0.42], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}}, "evidenceRefs": ["frame-detail"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 184, 184, 1.0)", "secondaryAlbedo": "rgba(150, 150, 150, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "primaryMaterialId": "frame"}, "attachment": {"parentSocket": "frame-leg-socket-fl", "localStart": [-0.25, 0.42, 0.25], "localEnd": [-0.25, 0.0, 0.25], "contactType": "socket", "embedDepth": 0.025, "overlap": 0.02, "gapTolerance": 0.0}};
  node_frame_leg_fl_5.add(mesh_frame_leg_fl_5);
  meshes["frame-leg-fl"] = mesh_frame_leg_fl_5;
  colliders["frame-leg-fl"] = {"type": "capsule", "size": [0.022, 0.42], "isTrigger": false};
  destructionGroups["frame"] ??= [];
  destructionGroups["frame"].push(node_frame_leg_fl_5);

  const attachment_frame_leg_fr_6 = {"parentSocket": "frame-leg-socket-fr", "localStart": [0.25, 0.42, 0.25], "localEnd": [0.25, 0.0, 0.25], "contactType": "socket", "embedDepth": 0.025, "overlap": 0.02, "gapTolerance": 0.0};
  const endpoint_frame_leg_fr_6 = makeAttachmentEndpoint(attachment_frame_leg_fr_6);
  const node_frame_leg_fr_6 = new THREE.Group();
  node_frame_leg_fr_6.name = "frame-leg-fr__pivot";
  node_frame_leg_fr_6.scale.set(1, 1, 1);
  if (endpoint_frame_leg_fr_6) {
    node_frame_leg_fr_6.position.copy(endpoint_frame_leg_fr_6.start);
    node_frame_leg_fr_6.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_frame_leg_fr_6.position.set(0.0, 0.0, 0.0);
    node_frame_leg_fr_6.rotation.set(0.0, 0.0, 0.0);
  }
  node_frame_leg_fr_6.userData.sculptComponent = {"id": "frame-leg-fr", "parent": "frame", "primitive": "tube", "level": "macro", "topologyClass": "assembled-solid", "topologyRationale": "Front-right sled leg: mirror of frame-leg-fl across the chair centerline.", "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0]}, "geometry": {"primitive": "tube", "size": [1, 1, 1]}, "dimensions": {"width": 1, "height": 1, "depth": 1}, "materialIds": ["frame"], "material": "frame", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "capsule", "size": [0.022, 0.42], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}}, "evidenceRefs": ["frame-detail"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 184, 184, 1.0)", "secondaryAlbedo": "rgba(150, 150, 150, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "primaryMaterialId": "frame"}, "attachment": {"parentSocket": "frame-leg-socket-fr", "localStart": [0.25, 0.42, 0.25], "localEnd": [0.25, 0.0, 0.25], "contactType": "socket", "embedDepth": 0.025, "overlap": 0.02, "gapTolerance": 0.0}};
  node_frame_leg_fr_6.userData.actionProfile = {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "capsule", "size": [0.022, 0.42], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}};
  (nodes["frame"] ?? root).add(node_frame_leg_fr_6);
  nodes["frame-leg-fr"] = node_frame_leg_fr_6;
  const mesh_frame_leg_fr_6Geometry = endpoint_frame_leg_fr_6
    ? new THREE.CylinderGeometry(endpoint_frame_leg_fr_6.endRadius, endpoint_frame_leg_fr_6.baseRadius, endpoint_frame_leg_fr_6.length, 8, 4)
    : buildTubeGeometry({"points": [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], "radius": 0.05, "closed": false});
  if (!endpoint_frame_leg_fr_6) {
    mesh_frame_leg_fr_6Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_frame_leg_fr_6 = new THREE.Mesh(
    mesh_frame_leg_fr_6Geometry,
    materialMap["frame"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_frame_leg_fr_6.name = "frame-leg-fr";
  if (endpoint_frame_leg_fr_6) {
    mesh_frame_leg_fr_6.position.copy(endpoint_frame_leg_fr_6.midpoint);
    mesh_frame_leg_fr_6.quaternion.copy(endpoint_frame_leg_fr_6.quaternion);
  }
  mesh_frame_leg_fr_6.castShadow = options.castShadow ?? true;
  mesh_frame_leg_fr_6.receiveShadow = options.receiveShadow ?? true;
  mesh_frame_leg_fr_6.userData.sculptComponent = {"id": "frame-leg-fr", "parent": "frame", "primitive": "tube", "level": "macro", "topologyClass": "assembled-solid", "topologyRationale": "Front-right sled leg: mirror of frame-leg-fl across the chair centerline.", "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0]}, "geometry": {"primitive": "tube", "size": [1, 1, 1]}, "dimensions": {"width": 1, "height": 1, "depth": 1}, "materialIds": ["frame"], "material": "frame", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "capsule", "size": [0.022, 0.42], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}}, "evidenceRefs": ["frame-detail"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 184, 184, 1.0)", "secondaryAlbedo": "rgba(150, 150, 150, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "primaryMaterialId": "frame"}, "attachment": {"parentSocket": "frame-leg-socket-fr", "localStart": [0.25, 0.42, 0.25], "localEnd": [0.25, 0.0, 0.25], "contactType": "socket", "embedDepth": 0.025, "overlap": 0.02, "gapTolerance": 0.0}};
  node_frame_leg_fr_6.add(mesh_frame_leg_fr_6);
  meshes["frame-leg-fr"] = mesh_frame_leg_fr_6;
  colliders["frame-leg-fr"] = {"type": "capsule", "size": [0.022, 0.42], "isTrigger": false};
  destructionGroups["frame"] ??= [];
  destructionGroups["frame"].push(node_frame_leg_fr_6);

  const attachment_frame_leg_rl_7 = {"parentSocket": "frame-leg-socket-rl", "localStart": [-0.25, 0.42, -0.25], "localEnd": [-0.25, 0.0, -0.25], "contactType": "socket", "embedDepth": 0.025, "overlap": 0.02, "gapTolerance": 0.0};
  const endpoint_frame_leg_rl_7 = makeAttachmentEndpoint(attachment_frame_leg_rl_7);
  const node_frame_leg_rl_7 = new THREE.Group();
  node_frame_leg_rl_7.name = "frame-leg-rl__pivot";
  node_frame_leg_rl_7.scale.set(1, 1, 1);
  if (endpoint_frame_leg_rl_7) {
    node_frame_leg_rl_7.position.copy(endpoint_frame_leg_rl_7.start);
    node_frame_leg_rl_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_frame_leg_rl_7.position.set(0.0, 0.0, 0.0);
    node_frame_leg_rl_7.rotation.set(0.0, 0.0, 0.0);
  }
  node_frame_leg_rl_7.userData.sculptComponent = {"id": "frame-leg-rl", "parent": "frame", "primitive": "tube", "level": "macro", "topologyClass": "assembled-solid", "topologyRationale": "Rear-left sled leg: hidden behind seat, mirrored from frame-leg-rr (low confidence, single view).", "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0]}, "geometry": {"primitive": "tube", "size": [1, 1, 1]}, "dimensions": {"width": 1, "height": 1, "depth": 1}, "materialIds": ["frame"], "material": "frame", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "capsule", "size": [0.022, 0.42], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}}, "evidenceRefs": ["frame-detail"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 184, 184, 1.0)", "secondaryAlbedo": "rgba(150, 150, 150, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "primaryMaterialId": "frame"}, "attachment": {"parentSocket": "frame-leg-socket-rl", "localStart": [-0.25, 0.42, -0.25], "localEnd": [-0.25, 0.0, -0.25], "contactType": "socket", "embedDepth": 0.025, "overlap": 0.02, "gapTolerance": 0.0}};
  node_frame_leg_rl_7.userData.actionProfile = {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "capsule", "size": [0.022, 0.42], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}};
  (nodes["frame"] ?? root).add(node_frame_leg_rl_7);
  nodes["frame-leg-rl"] = node_frame_leg_rl_7;
  const mesh_frame_leg_rl_7Geometry = endpoint_frame_leg_rl_7
    ? new THREE.CylinderGeometry(endpoint_frame_leg_rl_7.endRadius, endpoint_frame_leg_rl_7.baseRadius, endpoint_frame_leg_rl_7.length, 8, 4)
    : buildTubeGeometry({"points": [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], "radius": 0.05, "closed": false});
  if (!endpoint_frame_leg_rl_7) {
    mesh_frame_leg_rl_7Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_frame_leg_rl_7 = new THREE.Mesh(
    mesh_frame_leg_rl_7Geometry,
    materialMap["frame"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_frame_leg_rl_7.name = "frame-leg-rl";
  if (endpoint_frame_leg_rl_7) {
    mesh_frame_leg_rl_7.position.copy(endpoint_frame_leg_rl_7.midpoint);
    mesh_frame_leg_rl_7.quaternion.copy(endpoint_frame_leg_rl_7.quaternion);
  }
  mesh_frame_leg_rl_7.castShadow = options.castShadow ?? true;
  mesh_frame_leg_rl_7.receiveShadow = options.receiveShadow ?? true;
  mesh_frame_leg_rl_7.userData.sculptComponent = {"id": "frame-leg-rl", "parent": "frame", "primitive": "tube", "level": "macro", "topologyClass": "assembled-solid", "topologyRationale": "Rear-left sled leg: hidden behind seat, mirrored from frame-leg-rr (low confidence, single view).", "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0]}, "geometry": {"primitive": "tube", "size": [1, 1, 1]}, "dimensions": {"width": 1, "height": 1, "depth": 1}, "materialIds": ["frame"], "material": "frame", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "capsule", "size": [0.022, 0.42], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}}, "evidenceRefs": ["frame-detail"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 184, 184, 1.0)", "secondaryAlbedo": "rgba(150, 150, 150, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "primaryMaterialId": "frame"}, "attachment": {"parentSocket": "frame-leg-socket-rl", "localStart": [-0.25, 0.42, -0.25], "localEnd": [-0.25, 0.0, -0.25], "contactType": "socket", "embedDepth": 0.025, "overlap": 0.02, "gapTolerance": 0.0}};
  node_frame_leg_rl_7.add(mesh_frame_leg_rl_7);
  meshes["frame-leg-rl"] = mesh_frame_leg_rl_7;
  colliders["frame-leg-rl"] = {"type": "capsule", "size": [0.022, 0.42], "isTrigger": false};
  destructionGroups["frame"] ??= [];
  destructionGroups["frame"].push(node_frame_leg_rl_7);

  const attachment_frame_leg_rr_8 = {"parentSocket": "frame-leg-socket-rr", "localStart": [0.25, 0.42, -0.25], "localEnd": [0.25, 0.0, -0.25], "contactType": "socket", "embedDepth": 0.025, "overlap": 0.02, "gapTolerance": 0.0};
  const endpoint_frame_leg_rr_8 = makeAttachmentEndpoint(attachment_frame_leg_rr_8);
  const node_frame_leg_rr_8 = new THREE.Group();
  node_frame_leg_rr_8.name = "frame-leg-rr__pivot";
  node_frame_leg_rr_8.scale.set(1, 1, 1);
  if (endpoint_frame_leg_rr_8) {
    node_frame_leg_rr_8.position.copy(endpoint_frame_leg_rr_8.start);
    node_frame_leg_rr_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_frame_leg_rr_8.position.set(0.0, 0.0, 0.0);
    node_frame_leg_rr_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_frame_leg_rr_8.userData.sculptComponent = {"id": "frame-leg-rr", "parent": "frame", "primitive": "tube", "level": "macro", "topologyClass": "assembled-solid", "topologyRationale": "Rear-right sled leg: visible glimpse through the rear-right of the seat.", "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0]}, "geometry": {"primitive": "tube", "size": [1, 1, 1]}, "dimensions": {"width": 1, "height": 1, "depth": 1}, "materialIds": ["frame"], "material": "frame", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "capsule", "size": [0.022, 0.42], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}}, "evidenceRefs": ["frame-detail"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 184, 184, 1.0)", "secondaryAlbedo": "rgba(150, 150, 150, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "primaryMaterialId": "frame"}, "attachment": {"parentSocket": "frame-leg-socket-rr", "localStart": [0.25, 0.42, -0.25], "localEnd": [0.25, 0.0, -0.25], "contactType": "socket", "embedDepth": 0.025, "overlap": 0.02, "gapTolerance": 0.0}};
  node_frame_leg_rr_8.userData.actionProfile = {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "capsule", "size": [0.022, 0.42], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}};
  (nodes["frame"] ?? root).add(node_frame_leg_rr_8);
  nodes["frame-leg-rr"] = node_frame_leg_rr_8;
  const mesh_frame_leg_rr_8Geometry = endpoint_frame_leg_rr_8
    ? new THREE.CylinderGeometry(endpoint_frame_leg_rr_8.endRadius, endpoint_frame_leg_rr_8.baseRadius, endpoint_frame_leg_rr_8.length, 8, 4)
    : buildTubeGeometry({"points": [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], "radius": 0.05, "closed": false});
  if (!endpoint_frame_leg_rr_8) {
    mesh_frame_leg_rr_8Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_frame_leg_rr_8 = new THREE.Mesh(
    mesh_frame_leg_rr_8Geometry,
    materialMap["frame"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_frame_leg_rr_8.name = "frame-leg-rr";
  if (endpoint_frame_leg_rr_8) {
    mesh_frame_leg_rr_8.position.copy(endpoint_frame_leg_rr_8.midpoint);
    mesh_frame_leg_rr_8.quaternion.copy(endpoint_frame_leg_rr_8.quaternion);
  }
  mesh_frame_leg_rr_8.castShadow = options.castShadow ?? true;
  mesh_frame_leg_rr_8.receiveShadow = options.receiveShadow ?? true;
  mesh_frame_leg_rr_8.userData.sculptComponent = {"id": "frame-leg-rr", "parent": "frame", "primitive": "tube", "level": "macro", "topologyClass": "assembled-solid", "topologyRationale": "Rear-right sled leg: visible glimpse through the rear-right of the seat.", "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0]}, "geometry": {"primitive": "tube", "size": [1, 1, 1]}, "dimensions": {"width": 1, "height": 1, "depth": 1}, "materialIds": ["frame"], "material": "frame", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "capsule", "size": [0.022, 0.42], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}}, "evidenceRefs": ["frame-detail"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(184, 184, 184, 1.0)", "secondaryAlbedo": "rgba(150, 150, 150, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.85, "primaryMaterialId": "frame"}, "attachment": {"parentSocket": "frame-leg-socket-rr", "localStart": [0.25, 0.42, -0.25], "localEnd": [0.25, 0.0, -0.25], "contactType": "socket", "embedDepth": 0.025, "overlap": 0.02, "gapTolerance": 0.0}};
  node_frame_leg_rr_8.add(mesh_frame_leg_rr_8);
  meshes["frame-leg-rr"] = mesh_frame_leg_rr_8;
  colliders["frame-leg-rr"] = {"type": "capsule", "size": [0.022, 0.42], "isTrigger": false};
  destructionGroups["frame"] ??= [];
  destructionGroups["frame"].push(node_frame_leg_rr_8);

  const endpoint_seat_side_panel_left_9 = makeAttachmentEndpoint(null);
  const node_seat_side_panel_left_9 = new THREE.Group();
  node_seat_side_panel_left_9.name = "seat-side-panel-left__pivot";
  node_seat_side_panel_left_9.scale.set(1, 1, 1);
  if (endpoint_seat_side_panel_left_9) {
    node_seat_side_panel_left_9.position.copy(endpoint_seat_side_panel_left_9.start);
    node_seat_side_panel_left_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seat_side_panel_left_9.position.set(-0.275, 0.0, 0.0);
    node_seat_side_panel_left_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_seat_side_panel_left_9.userData.sculptComponent = {"id": "seat-side-panel-left", "parent": "seat", "primitive": "box", "level": "meso", "topologyClass": "conforming-shell", "topologyRationale": "Left side panel of the seat cushion, fabric over foam.", "transform": {"position": [-0.275, 0, 0], "rotation": [0, 0, 0]}, "geometry": {"primitive": "box", "size": [0.005, 0.1, 0.55]}, "dimensions": {"width": 0.005, "height": 0.1, "depth": 0.55}, "materialIds": ["upholstery"], "material": "upholstery", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}}, "evidenceRefs": ["full-object"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(28, 44, 82, 1.0)", "secondaryAlbedo": "rgba(20, 32, 60, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "primaryMaterialId": "upholstery"}, "attachment": {"parentSocket": "seat-side-left", "localStart": [-0.275, -0.05, 0], "localEnd": [-0.275, 0.05, 0.55], "contactType": "overlap", "embedDepth": 0.005, "overlap": 0.02, "gapTolerance": 0.0}};
  node_seat_side_panel_left_9.userData.actionProfile = {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}};
  (nodes["seat"] ?? root).add(node_seat_side_panel_left_9);
  nodes["seat-side-panel-left"] = node_seat_side_panel_left_9;
  const mesh_seat_side_panel_left_9Geometry = endpoint_seat_side_panel_left_9
    ? new THREE.CylinderGeometry(endpoint_seat_side_panel_left_9.endRadius, endpoint_seat_side_panel_left_9.baseRadius, endpoint_seat_side_panel_left_9.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_seat_side_panel_left_9) {
    mesh_seat_side_panel_left_9Geometry.scale(0.005, 0.1, 0.55);
  }
  const mesh_seat_side_panel_left_9 = new THREE.Mesh(
    mesh_seat_side_panel_left_9Geometry,
    materialMap["upholstery"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seat_side_panel_left_9.name = "seat-side-panel-left";
  if (endpoint_seat_side_panel_left_9) {
    mesh_seat_side_panel_left_9.position.copy(endpoint_seat_side_panel_left_9.midpoint);
    mesh_seat_side_panel_left_9.quaternion.copy(endpoint_seat_side_panel_left_9.quaternion);
  }
  mesh_seat_side_panel_left_9.castShadow = options.castShadow ?? true;
  mesh_seat_side_panel_left_9.receiveShadow = options.receiveShadow ?? true;
  mesh_seat_side_panel_left_9.userData.sculptComponent = {"id": "seat-side-panel-left", "parent": "seat", "primitive": "box", "level": "meso", "topologyClass": "conforming-shell", "topologyRationale": "Left side panel of the seat cushion, fabric over foam.", "transform": {"position": [-0.275, 0, 0], "rotation": [0, 0, 0]}, "geometry": {"primitive": "box", "size": [0.005, 0.1, 0.55]}, "dimensions": {"width": 0.005, "height": 0.1, "depth": 0.55}, "materialIds": ["upholstery"], "material": "upholstery", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}}, "evidenceRefs": ["full-object"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(28, 44, 82, 1.0)", "secondaryAlbedo": "rgba(20, 32, 60, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "primaryMaterialId": "upholstery"}, "attachment": {"parentSocket": "seat-side-left", "localStart": [-0.275, -0.05, 0], "localEnd": [-0.275, 0.05, 0.55], "contactType": "overlap", "embedDepth": 0.005, "overlap": 0.02, "gapTolerance": 0.0}};
  node_seat_side_panel_left_9.add(mesh_seat_side_panel_left_9);
  meshes["seat-side-panel-left"] = mesh_seat_side_panel_left_9;
  colliders["seat-side-panel-left"] = {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false};
  destructionGroups["frame"] ??= [];
  destructionGroups["frame"].push(node_seat_side_panel_left_9);

  const endpoint_backrest_seam_strip_10 = makeAttachmentEndpoint(null);
  const node_backrest_seam_strip_10 = new THREE.Group();
  node_backrest_seam_strip_10.name = "backrest-seam-strip__pivot";
  node_backrest_seam_strip_10.scale.set(1, 1, 1);
  if (endpoint_backrest_seam_strip_10) {
    node_backrest_seam_strip_10.position.copy(endpoint_backrest_seam_strip_10.start);
    node_backrest_seam_strip_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_backrest_seam_strip_10.position.set(0.0, 0.0, 0.0);
    node_backrest_seam_strip_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_backrest_seam_strip_10.userData.sculptComponent = {"id": "backrest-seam-strip", "parent": "backrest", "primitive": "box", "level": "micro", "topologyClass": "surface-relief", "topologyRationale": "Horizontal seam band embedded in backrest at mid-height. Refined after the form-refinement review showed the original 1mm protruation was invisible at review distance: the band now stands 5mm proud per face and is slightly inset from the sides, so it casts a visible shadow line like a real sewn seam.", "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0]}, "geometry": {"primitive": "box", "size": [0.53, 0.03, 0.06]}, "dimensions": {"width": 0.53, "height": 0.03, "depth": 0.06}, "materialIds": ["upholstery"], "material": "upholstery", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}}, "evidenceRefs": ["backrest-seam-detail"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(28, 44, 82, 1.0)", "secondaryAlbedo": "rgba(20, 32, 60, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "primaryMaterialId": "upholstery"}, "attachment": {"parentSocket": "backrest-front", "localStart": [-0.265, -0.015, 0.028], "localEnd": [0.265, 0.015, 0.03], "contactType": "overlap", "embedDepth": 0.005, "overlap": 0.02, "gapTolerance": 0.0}};
  node_backrest_seam_strip_10.userData.actionProfile = {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}};
  (nodes["backrest"] ?? root).add(node_backrest_seam_strip_10);
  nodes["backrest-seam-strip"] = node_backrest_seam_strip_10;
  const mesh_backrest_seam_strip_10Geometry = endpoint_backrest_seam_strip_10
    ? new THREE.CylinderGeometry(endpoint_backrest_seam_strip_10.endRadius, endpoint_backrest_seam_strip_10.baseRadius, endpoint_backrest_seam_strip_10.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_backrest_seam_strip_10) {
    mesh_backrest_seam_strip_10Geometry.scale(0.53, 0.03, 0.06);
  }
  const mesh_backrest_seam_strip_10 = new THREE.Mesh(
    mesh_backrest_seam_strip_10Geometry,
    materialMap["upholstery"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_backrest_seam_strip_10.name = "backrest-seam-strip";
  if (endpoint_backrest_seam_strip_10) {
    mesh_backrest_seam_strip_10.position.copy(endpoint_backrest_seam_strip_10.midpoint);
    mesh_backrest_seam_strip_10.quaternion.copy(endpoint_backrest_seam_strip_10.quaternion);
  }
  mesh_backrest_seam_strip_10.castShadow = options.castShadow ?? true;
  mesh_backrest_seam_strip_10.receiveShadow = options.receiveShadow ?? true;
  mesh_backrest_seam_strip_10.userData.sculptComponent = {"id": "backrest-seam-strip", "parent": "backrest", "primitive": "box", "level": "micro", "topologyClass": "surface-relief", "topologyRationale": "Horizontal seam band embedded in backrest at mid-height. Refined after the form-refinement review showed the original 1mm protruation was invisible at review distance: the band now stands 5mm proud per face and is slightly inset from the sides, so it casts a visible shadow line like a real sewn seam.", "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0]}, "geometry": {"primitive": "box", "size": [0.53, 0.03, 0.06]}, "dimensions": {"width": 0.53, "height": 0.03, "depth": 0.06}, "materialIds": ["upholstery"], "material": "upholstery", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}}, "evidenceRefs": ["backrest-seam-detail"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(28, 44, 82, 1.0)", "secondaryAlbedo": "rgba(20, 32, 60, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "primaryMaterialId": "upholstery"}, "attachment": {"parentSocket": "backrest-front", "localStart": [-0.265, -0.015, 0.028], "localEnd": [0.265, 0.015, 0.03], "contactType": "overlap", "embedDepth": 0.005, "overlap": 0.02, "gapTolerance": 0.0}};
  node_backrest_seam_strip_10.add(mesh_backrest_seam_strip_10);
  meshes["backrest-seam-strip"] = mesh_backrest_seam_strip_10;
  colliders["backrest-seam-strip"] = {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false};
  destructionGroups["frame"] ??= [];
  destructionGroups["frame"].push(node_backrest_seam_strip_10);

  const endpoint_seat_front_bevel_11 = makeAttachmentEndpoint(null);
  const node_seat_front_bevel_11 = new THREE.Group();
  node_seat_front_bevel_11.name = "seat-front-bevel__pivot";
  node_seat_front_bevel_11.scale.set(1, 1, 1);
  if (endpoint_seat_front_bevel_11) {
    node_seat_front_bevel_11.position.copy(endpoint_seat_front_bevel_11.start);
    node_seat_front_bevel_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seat_front_bevel_11.position.set(0.0, -0.02, 0.27);
    node_seat_front_bevel_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_seat_front_bevel_11.userData.sculptComponent = {"id": "seat-front-bevel", "parent": "seat", "primitive": "box", "level": "micro", "topologyClass": "surface-relief", "topologyRationale": "Soft forward bevel along the seat front edge.", "transform": {"position": [0, -0.02, 0.27], "rotation": [0, 0, 0]}, "geometry": {"primitive": "box", "size": [0.55, 0.06, 0.08]}, "dimensions": {"width": 0.55, "height": 0.06, "depth": 0.08}, "materialIds": ["upholstery"], "material": "upholstery", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}}, "evidenceRefs": ["seat-front-bevel-detail"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(28, 44, 82, 1.0)", "secondaryAlbedo": "rgba(20, 32, 60, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "primaryMaterialId": "upholstery"}, "attachment": {"parentSocket": "seat-front", "localStart": [-0.275, -0.05, 0.23], "localEnd": [0.275, 0.01, 0.31], "contactType": "overlap", "embedDepth": 0.005, "overlap": 0.02, "gapTolerance": 0.0}};
  node_seat_front_bevel_11.userData.actionProfile = {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}};
  (nodes["seat"] ?? root).add(node_seat_front_bevel_11);
  nodes["seat-front-bevel"] = node_seat_front_bevel_11;
  const mesh_seat_front_bevel_11Geometry = endpoint_seat_front_bevel_11
    ? new THREE.CylinderGeometry(endpoint_seat_front_bevel_11.endRadius, endpoint_seat_front_bevel_11.baseRadius, endpoint_seat_front_bevel_11.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_seat_front_bevel_11) {
    mesh_seat_front_bevel_11Geometry.scale(0.55, 0.06, 0.08);
  }
  const mesh_seat_front_bevel_11 = new THREE.Mesh(
    mesh_seat_front_bevel_11Geometry,
    materialMap["upholstery"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seat_front_bevel_11.name = "seat-front-bevel";
  if (endpoint_seat_front_bevel_11) {
    mesh_seat_front_bevel_11.position.copy(endpoint_seat_front_bevel_11.midpoint);
    mesh_seat_front_bevel_11.quaternion.copy(endpoint_seat_front_bevel_11.quaternion);
  }
  mesh_seat_front_bevel_11.castShadow = options.castShadow ?? true;
  mesh_seat_front_bevel_11.receiveShadow = options.receiveShadow ?? true;
  mesh_seat_front_bevel_11.userData.sculptComponent = {"id": "seat-front-bevel", "parent": "seat", "primitive": "box", "level": "micro", "topologyClass": "surface-relief", "topologyRationale": "Soft forward bevel along the seat front edge.", "transform": {"position": [0, -0.02, 0.27], "rotation": [0, 0, 0]}, "geometry": {"primitive": "box", "size": [0.55, 0.06, 0.08]}, "dimensions": {"width": 0.55, "height": 0.06, "depth": 0.08}, "materialIds": ["upholstery"], "material": "upholstery", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}}, "evidenceRefs": ["seat-front-bevel-detail"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(28, 44, 82, 1.0)", "secondaryAlbedo": "rgba(20, 32, 60, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "primaryMaterialId": "upholstery"}, "attachment": {"parentSocket": "seat-front", "localStart": [-0.275, -0.05, 0.23], "localEnd": [0.275, 0.01, 0.31], "contactType": "overlap", "embedDepth": 0.005, "overlap": 0.02, "gapTolerance": 0.0}};
  node_seat_front_bevel_11.add(mesh_seat_front_bevel_11);
  meshes["seat-front-bevel"] = mesh_seat_front_bevel_11;
  colliders["seat-front-bevel"] = {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false};
  destructionGroups["frame"] ??= [];
  destructionGroups["frame"].push(node_seat_front_bevel_11);

  const endpoint_backrest_top_edge_chamfer_12 = makeAttachmentEndpoint(null);
  const node_backrest_top_edge_chamfer_12 = new THREE.Group();
  node_backrest_top_edge_chamfer_12.name = "backrest-top-edge-chamfer__pivot";
  node_backrest_top_edge_chamfer_12.scale.set(1, 1, 1);
  if (endpoint_backrest_top_edge_chamfer_12) {
    node_backrest_top_edge_chamfer_12.position.copy(endpoint_backrest_top_edge_chamfer_12.start);
    node_backrest_top_edge_chamfer_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_backrest_top_edge_chamfer_12.position.set(0.0, 0.275, 0.0);
    node_backrest_top_edge_chamfer_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_backrest_top_edge_chamfer_12.userData.sculptComponent = {"id": "backrest-top-edge-chamfer", "parent": "backrest", "primitive": "box", "level": "micro", "topologyClass": "surface-relief", "topologyRationale": "Slight rounded chamfer on the top edge of the backrest.", "transform": {"position": [0, 0.275, 0], "rotation": [0, 0, 0]}, "geometry": {"primitive": "box", "size": [0.55, 0.01, 0.052]}, "dimensions": {"width": 0.55, "height": 0.01, "depth": 0.052}, "materialIds": ["upholstery"], "material": "upholstery", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}}, "evidenceRefs": ["full-object"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(28, 44, 82, 1.0)", "secondaryAlbedo": "rgba(20, 32, 60, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "primaryMaterialId": "upholstery"}, "attachment": {"parentSocket": "backrest-top", "localStart": [-0.275, 0.275, 0], "localEnd": [0.275, 0.28, 0.026], "contactType": "overlap", "embedDepth": 0.005, "overlap": 0.02, "gapTolerance": 0.0}};
  node_backrest_top_edge_chamfer_12.userData.actionProfile = {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}};
  (nodes["backrest"] ?? root).add(node_backrest_top_edge_chamfer_12);
  nodes["backrest-top-edge-chamfer"] = node_backrest_top_edge_chamfer_12;
  const mesh_backrest_top_edge_chamfer_12Geometry = endpoint_backrest_top_edge_chamfer_12
    ? new THREE.CylinderGeometry(endpoint_backrest_top_edge_chamfer_12.endRadius, endpoint_backrest_top_edge_chamfer_12.baseRadius, endpoint_backrest_top_edge_chamfer_12.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_backrest_top_edge_chamfer_12) {
    mesh_backrest_top_edge_chamfer_12Geometry.scale(0.55, 0.01, 0.052);
  }
  const mesh_backrest_top_edge_chamfer_12 = new THREE.Mesh(
    mesh_backrest_top_edge_chamfer_12Geometry,
    materialMap["upholstery"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_backrest_top_edge_chamfer_12.name = "backrest-top-edge-chamfer";
  if (endpoint_backrest_top_edge_chamfer_12) {
    mesh_backrest_top_edge_chamfer_12.position.copy(endpoint_backrest_top_edge_chamfer_12.midpoint);
    mesh_backrest_top_edge_chamfer_12.quaternion.copy(endpoint_backrest_top_edge_chamfer_12.quaternion);
  }
  mesh_backrest_top_edge_chamfer_12.castShadow = options.castShadow ?? true;
  mesh_backrest_top_edge_chamfer_12.receiveShadow = options.receiveShadow ?? true;
  mesh_backrest_top_edge_chamfer_12.userData.sculptComponent = {"id": "backrest-top-edge-chamfer", "parent": "backrest", "primitive": "box", "level": "micro", "topologyClass": "surface-relief", "topologyRationale": "Slight rounded chamfer on the top edge of the backrest.", "transform": {"position": [0, 0.275, 0], "rotation": [0, 0, 0]}, "geometry": {"primitive": "box", "size": [0.55, 0.01, 0.052]}, "dimensions": {"width": 0.55, "height": 0.01, "depth": 0.052}, "materialIds": ["upholstery"], "material": "upholstery", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}}, "evidenceRefs": ["full-object"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(28, 44, 82, 1.0)", "secondaryAlbedo": "rgba(20, 32, 60, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "primaryMaterialId": "upholstery"}, "attachment": {"parentSocket": "backrest-top", "localStart": [-0.275, 0.275, 0], "localEnd": [0.275, 0.28, 0.026], "contactType": "overlap", "embedDepth": 0.005, "overlap": 0.02, "gapTolerance": 0.0}};
  node_backrest_top_edge_chamfer_12.add(mesh_backrest_top_edge_chamfer_12);
  meshes["backrest-top-edge-chamfer"] = mesh_backrest_top_edge_chamfer_12;
  colliders["backrest-top-edge-chamfer"] = {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false};
  destructionGroups["frame"] ??= [];
  destructionGroups["frame"].push(node_backrest_top_edge_chamfer_12);

  const endpoint_seat_side_trim_13 = makeAttachmentEndpoint(null);
  const node_seat_side_trim_13 = new THREE.Group();
  node_seat_side_trim_13.name = "seat-side-trim__pivot";
  node_seat_side_trim_13.scale.set(1, 1, 1);
  if (endpoint_seat_side_trim_13) {
    node_seat_side_trim_13.position.copy(endpoint_seat_side_trim_13.start);
    node_seat_side_trim_13.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_seat_side_trim_13.position.set(-0.275, 0.0, 0.0);
    node_seat_side_trim_13.rotation.set(0.0, 0.0, 0.0);
  }
  node_seat_side_trim_13.userData.sculptComponent = {"id": "seat-side-trim", "parent": "seat", "primitive": "box", "level": "micro", "topologyClass": "surface-relief", "topologyRationale": "Subtle horizontal seam-line on the seat side panel as a stitch detail.", "transform": {"position": [-0.275, 0, 0.0], "rotation": [0, 0, 0]}, "geometry": {"primitive": "box", "size": [0.002, 0.005, 0.5]}, "dimensions": {"width": 0.002, "height": 0.005, "depth": 0.5}, "materialIds": ["upholstery"], "material": "upholstery", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}}, "evidenceRefs": ["full-object"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(28, 44, 82, 1.0)", "secondaryAlbedo": "rgba(20, 32, 60, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "primaryMaterialId": "upholstery"}, "attachment": {"parentSocket": "seat-side-trim", "localStart": [-0.276, 0, 0], "localEnd": [-0.275, 0, 0.5], "contactType": "overlap", "embedDepth": 0.002, "overlap": 0.02, "gapTolerance": 0.0}};
  node_seat_side_trim_13.userData.actionProfile = {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}};
  (nodes["seat"] ?? root).add(node_seat_side_trim_13);
  nodes["seat-side-trim"] = node_seat_side_trim_13;
  const mesh_seat_side_trim_13Geometry = endpoint_seat_side_trim_13
    ? new THREE.CylinderGeometry(endpoint_seat_side_trim_13.endRadius, endpoint_seat_side_trim_13.baseRadius, endpoint_seat_side_trim_13.length, 8, 4)
    : new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  if (!endpoint_seat_side_trim_13) {
    mesh_seat_side_trim_13Geometry.scale(0.002, 0.005, 0.5);
  }
  const mesh_seat_side_trim_13 = new THREE.Mesh(
    mesh_seat_side_trim_13Geometry,
    materialMap["upholstery"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seat_side_trim_13.name = "seat-side-trim";
  if (endpoint_seat_side_trim_13) {
    mesh_seat_side_trim_13.position.copy(endpoint_seat_side_trim_13.midpoint);
    mesh_seat_side_trim_13.quaternion.copy(endpoint_seat_side_trim_13.quaternion);
  }
  mesh_seat_side_trim_13.castShadow = options.castShadow ?? true;
  mesh_seat_side_trim_13.receiveShadow = options.receiveShadow ?? true;
  mesh_seat_side_trim_13.userData.sculptComponent = {"id": "seat-side-trim", "parent": "seat", "primitive": "box", "level": "micro", "topologyClass": "surface-relief", "topologyRationale": "Subtle horizontal seam-line on the seat side panel as a stitch detail.", "transform": {"position": [-0.275, 0, 0.0], "rotation": [0, 0, 0]}, "geometry": {"primitive": "box", "size": [0.002, 0.005, 0.5]}, "dimensions": {"width": 0.002, "height": 0.005, "depth": 0.5}, "materialIds": ["upholstery"], "material": "upholstery", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}}, "evidenceRefs": ["full-object"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(28, 44, 82, 1.0)", "secondaryAlbedo": "rgba(20, 32, 60, 1.0)", "materialClass": "fabric", "materialClassConfidence": 0.85, "primaryMaterialId": "upholstery"}, "attachment": {"parentSocket": "seat-side-trim", "localStart": [-0.276, 0, 0], "localEnd": [-0.275, 0, 0.5], "contactType": "overlap", "embedDepth": 0.002, "overlap": 0.02, "gapTolerance": 0.0}};
  node_seat_side_trim_13.add(mesh_seat_side_trim_13);
  meshes["seat-side-trim"] = mesh_seat_side_trim_13;
  colliders["seat-side-trim"] = {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false};
  destructionGroups["frame"] ??= [];
  destructionGroups["frame"].push(node_seat_side_trim_13);

  const attachment_leg_glide_fl_14 = {"parentSocket": "frame-leg-fl-bottom", "localStart": [-0.25, -0.42, 0.25], "localEnd": [-0.25, -0.44, 0.25], "contactType": "butt", "embedDepth": 0.005, "overlap": 0.02, "gapTolerance": 0.0};
  const endpoint_leg_glide_fl_14 = makeAttachmentEndpoint(attachment_leg_glide_fl_14);
  const node_leg_glide_fl_14 = new THREE.Group();
  node_leg_glide_fl_14.name = "leg-glide-fl__pivot";
  node_leg_glide_fl_14.scale.set(1, 1, 1);
  if (endpoint_leg_glide_fl_14) {
    node_leg_glide_fl_14.position.copy(endpoint_leg_glide_fl_14.start);
    node_leg_glide_fl_14.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_leg_glide_fl_14.position.set(-0.25, -0.01, -0.22);
    node_leg_glide_fl_14.rotation.set(0.0, 0.0, 0.0);
  }
  node_leg_glide_fl_14.userData.sculptComponent = {"id": "leg-glide-fl", "parent": "frame-leg-fl", "primitive": "cylinder", "level": "micro", "topologyClass": "conforming-shell", "topologyRationale": "Dark plastic foot at the bottom of the front-left leg.", "transform": {"position": [-0.25, -0.01, -0.22], "rotation": [0, 0, 0]}, "geometry": {"primitive": "cylinder", "size": [0.025, 0.025, 0.02]}, "dimensions": {"width": 0.025, "height": 0.025, "depth": 0.02}, "materialIds": ["glides"], "material": "glides", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}}, "evidenceRefs": ["glides-detail"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 26, 1.0)", "secondaryAlbedo": "rgba(0, 0, 0, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.85, "primaryMaterialId": "glides"}, "attachment": {"parentSocket": "frame-leg-fl-bottom", "localStart": [-0.25, -0.42, 0.25], "localEnd": [-0.25, -0.44, 0.25], "contactType": "butt", "embedDepth": 0.005, "overlap": 0.02, "gapTolerance": 0.0}};
  node_leg_glide_fl_14.userData.actionProfile = {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}};
  (nodes["frame-leg-fl"] ?? root).add(node_leg_glide_fl_14);
  nodes["leg-glide-fl"] = node_leg_glide_fl_14;
  const mesh_leg_glide_fl_14Geometry = endpoint_leg_glide_fl_14
    ? new THREE.CylinderGeometry(endpoint_leg_glide_fl_14.endRadius, endpoint_leg_glide_fl_14.baseRadius, endpoint_leg_glide_fl_14.length, 8, 4)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 4);
  if (!endpoint_leg_glide_fl_14) {
    mesh_leg_glide_fl_14Geometry.scale(0.025, 0.025, 0.02);
  }
  const mesh_leg_glide_fl_14 = new THREE.Mesh(
    mesh_leg_glide_fl_14Geometry,
    materialMap["glides"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leg_glide_fl_14.name = "leg-glide-fl";
  if (endpoint_leg_glide_fl_14) {
    mesh_leg_glide_fl_14.position.copy(endpoint_leg_glide_fl_14.midpoint);
    mesh_leg_glide_fl_14.quaternion.copy(endpoint_leg_glide_fl_14.quaternion);
  }
  mesh_leg_glide_fl_14.castShadow = options.castShadow ?? true;
  mesh_leg_glide_fl_14.receiveShadow = options.receiveShadow ?? true;
  mesh_leg_glide_fl_14.userData.sculptComponent = {"id": "leg-glide-fl", "parent": "frame-leg-fl", "primitive": "cylinder", "level": "micro", "topologyClass": "conforming-shell", "topologyRationale": "Dark plastic foot at the bottom of the front-left leg.", "transform": {"position": [-0.25, -0.01, -0.22], "rotation": [0, 0, 0]}, "geometry": {"primitive": "cylinder", "size": [0.025, 0.025, 0.02]}, "dimensions": {"width": 0.025, "height": 0.025, "depth": 0.02}, "materialIds": ["glides"], "material": "glides", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}}, "evidenceRefs": ["glides-detail"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 26, 1.0)", "secondaryAlbedo": "rgba(0, 0, 0, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.85, "primaryMaterialId": "glides"}, "attachment": {"parentSocket": "frame-leg-fl-bottom", "localStart": [-0.25, -0.42, 0.25], "localEnd": [-0.25, -0.44, 0.25], "contactType": "butt", "embedDepth": 0.005, "overlap": 0.02, "gapTolerance": 0.0}};
  node_leg_glide_fl_14.add(mesh_leg_glide_fl_14);
  meshes["leg-glide-fl"] = mesh_leg_glide_fl_14;
  colliders["leg-glide-fl"] = {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false};
  destructionGroups["frame"] ??= [];
  destructionGroups["frame"].push(node_leg_glide_fl_14);

  const attachment_leg_glide_fr_15 = {"parentSocket": "frame-leg-fr-bottom", "localStart": [0.25, -0.42, 0.25], "localEnd": [0.25, -0.44, 0.25], "contactType": "butt", "embedDepth": 0.005, "overlap": 0.02, "gapTolerance": 0.0};
  const endpoint_leg_glide_fr_15 = makeAttachmentEndpoint(attachment_leg_glide_fr_15);
  const node_leg_glide_fr_15 = new THREE.Group();
  node_leg_glide_fr_15.name = "leg-glide-fr__pivot";
  node_leg_glide_fr_15.scale.set(1, 1, 1);
  if (endpoint_leg_glide_fr_15) {
    node_leg_glide_fr_15.position.copy(endpoint_leg_glide_fr_15.start);
    node_leg_glide_fr_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_leg_glide_fr_15.position.set(0.25, -0.01, -0.22);
    node_leg_glide_fr_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_leg_glide_fr_15.userData.sculptComponent = {"id": "leg-glide-fr", "parent": "frame-leg-fr", "primitive": "cylinder", "level": "micro", "topologyClass": "conforming-shell", "topologyRationale": "Dark plastic foot at the bottom of the front-right leg.", "transform": {"position": [0.25, -0.01, -0.22], "rotation": [0, 0, 0]}, "geometry": {"primitive": "cylinder", "size": [0.025, 0.025, 0.02]}, "dimensions": {"width": 0.025, "height": 0.025, "depth": 0.02}, "materialIds": ["glides"], "material": "glides", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}}, "evidenceRefs": ["glides-detail"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 26, 1.0)", "secondaryAlbedo": "rgba(0, 0, 0, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.85, "primaryMaterialId": "glides"}, "attachment": {"parentSocket": "frame-leg-fr-bottom", "localStart": [0.25, -0.42, 0.25], "localEnd": [0.25, -0.44, 0.25], "contactType": "butt", "embedDepth": 0.005, "overlap": 0.02, "gapTolerance": 0.0}};
  node_leg_glide_fr_15.userData.actionProfile = {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}};
  (nodes["frame-leg-fr"] ?? root).add(node_leg_glide_fr_15);
  nodes["leg-glide-fr"] = node_leg_glide_fr_15;
  const mesh_leg_glide_fr_15Geometry = endpoint_leg_glide_fr_15
    ? new THREE.CylinderGeometry(endpoint_leg_glide_fr_15.endRadius, endpoint_leg_glide_fr_15.baseRadius, endpoint_leg_glide_fr_15.length, 8, 4)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 4);
  if (!endpoint_leg_glide_fr_15) {
    mesh_leg_glide_fr_15Geometry.scale(0.025, 0.025, 0.02);
  }
  const mesh_leg_glide_fr_15 = new THREE.Mesh(
    mesh_leg_glide_fr_15Geometry,
    materialMap["glides"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leg_glide_fr_15.name = "leg-glide-fr";
  if (endpoint_leg_glide_fr_15) {
    mesh_leg_glide_fr_15.position.copy(endpoint_leg_glide_fr_15.midpoint);
    mesh_leg_glide_fr_15.quaternion.copy(endpoint_leg_glide_fr_15.quaternion);
  }
  mesh_leg_glide_fr_15.castShadow = options.castShadow ?? true;
  mesh_leg_glide_fr_15.receiveShadow = options.receiveShadow ?? true;
  mesh_leg_glide_fr_15.userData.sculptComponent = {"id": "leg-glide-fr", "parent": "frame-leg-fr", "primitive": "cylinder", "level": "micro", "topologyClass": "conforming-shell", "topologyRationale": "Dark plastic foot at the bottom of the front-right leg.", "transform": {"position": [0.25, -0.01, -0.22], "rotation": [0, 0, 0]}, "geometry": {"primitive": "cylinder", "size": [0.025, 0.025, 0.02]}, "dimensions": {"width": 0.025, "height": 0.025, "depth": 0.02}, "materialIds": ["glides"], "material": "glides", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}}, "evidenceRefs": ["glides-detail"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 26, 1.0)", "secondaryAlbedo": "rgba(0, 0, 0, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.85, "primaryMaterialId": "glides"}, "attachment": {"parentSocket": "frame-leg-fr-bottom", "localStart": [0.25, -0.42, 0.25], "localEnd": [0.25, -0.44, 0.25], "contactType": "butt", "embedDepth": 0.005, "overlap": 0.02, "gapTolerance": 0.0}};
  node_leg_glide_fr_15.add(mesh_leg_glide_fr_15);
  meshes["leg-glide-fr"] = mesh_leg_glide_fr_15;
  colliders["leg-glide-fr"] = {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false};
  destructionGroups["frame"] ??= [];
  destructionGroups["frame"].push(node_leg_glide_fr_15);

  const attachment_leg_glide_rl_16 = {"parentSocket": "frame-leg-rl-bottom", "localStart": [-0.25, -0.42, -0.25], "localEnd": [-0.25, -0.44, -0.25], "contactType": "butt", "embedDepth": 0.005, "overlap": 0.02, "gapTolerance": 0.0};
  const endpoint_leg_glide_rl_16 = makeAttachmentEndpoint(attachment_leg_glide_rl_16);
  const node_leg_glide_rl_16 = new THREE.Group();
  node_leg_glide_rl_16.name = "leg-glide-rl__pivot";
  node_leg_glide_rl_16.scale.set(1, 1, 1);
  if (endpoint_leg_glide_rl_16) {
    node_leg_glide_rl_16.position.copy(endpoint_leg_glide_rl_16.start);
    node_leg_glide_rl_16.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_leg_glide_rl_16.position.set(-0.25, -0.01, -0.25);
    node_leg_glide_rl_16.rotation.set(0.0, 0.0, 0.0);
  }
  node_leg_glide_rl_16.userData.sculptComponent = {"id": "leg-glide-rl", "parent": "frame-leg-rl", "primitive": "cylinder", "level": "micro", "topologyClass": "conforming-shell", "topologyRationale": "Dark plastic foot at the bottom of the rear-left leg.", "transform": {"position": [-0.25, -0.01, -0.25], "rotation": [0, 0, 0]}, "geometry": {"primitive": "cylinder", "size": [0.025, 0.025, 0.02]}, "dimensions": {"width": 0.025, "height": 0.025, "depth": 0.02}, "materialIds": ["glides"], "material": "glides", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}}, "evidenceRefs": ["glides-detail"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 26, 1.0)", "secondaryAlbedo": "rgba(0, 0, 0, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.85, "primaryMaterialId": "glides"}, "attachment": {"parentSocket": "frame-leg-rl-bottom", "localStart": [-0.25, -0.42, -0.25], "localEnd": [-0.25, -0.44, -0.25], "contactType": "butt", "embedDepth": 0.005, "overlap": 0.02, "gapTolerance": 0.0}};
  node_leg_glide_rl_16.userData.actionProfile = {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}};
  (nodes["frame-leg-rl"] ?? root).add(node_leg_glide_rl_16);
  nodes["leg-glide-rl"] = node_leg_glide_rl_16;
  const mesh_leg_glide_rl_16Geometry = endpoint_leg_glide_rl_16
    ? new THREE.CylinderGeometry(endpoint_leg_glide_rl_16.endRadius, endpoint_leg_glide_rl_16.baseRadius, endpoint_leg_glide_rl_16.length, 8, 4)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 4);
  if (!endpoint_leg_glide_rl_16) {
    mesh_leg_glide_rl_16Geometry.scale(0.025, 0.025, 0.02);
  }
  const mesh_leg_glide_rl_16 = new THREE.Mesh(
    mesh_leg_glide_rl_16Geometry,
    materialMap["glides"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leg_glide_rl_16.name = "leg-glide-rl";
  if (endpoint_leg_glide_rl_16) {
    mesh_leg_glide_rl_16.position.copy(endpoint_leg_glide_rl_16.midpoint);
    mesh_leg_glide_rl_16.quaternion.copy(endpoint_leg_glide_rl_16.quaternion);
  }
  mesh_leg_glide_rl_16.castShadow = options.castShadow ?? true;
  mesh_leg_glide_rl_16.receiveShadow = options.receiveShadow ?? true;
  mesh_leg_glide_rl_16.userData.sculptComponent = {"id": "leg-glide-rl", "parent": "frame-leg-rl", "primitive": "cylinder", "level": "micro", "topologyClass": "conforming-shell", "topologyRationale": "Dark plastic foot at the bottom of the rear-left leg.", "transform": {"position": [-0.25, -0.01, -0.25], "rotation": [0, 0, 0]}, "geometry": {"primitive": "cylinder", "size": [0.025, 0.025, 0.02]}, "dimensions": {"width": 0.025, "height": 0.025, "depth": 0.02}, "materialIds": ["glides"], "material": "glides", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}}, "evidenceRefs": ["glides-detail"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 26, 1.0)", "secondaryAlbedo": "rgba(0, 0, 0, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.85, "primaryMaterialId": "glides"}, "attachment": {"parentSocket": "frame-leg-rl-bottom", "localStart": [-0.25, -0.42, -0.25], "localEnd": [-0.25, -0.44, -0.25], "contactType": "butt", "embedDepth": 0.005, "overlap": 0.02, "gapTolerance": 0.0}};
  node_leg_glide_rl_16.add(mesh_leg_glide_rl_16);
  meshes["leg-glide-rl"] = mesh_leg_glide_rl_16;
  colliders["leg-glide-rl"] = {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false};
  destructionGroups["frame"] ??= [];
  destructionGroups["frame"].push(node_leg_glide_rl_16);

  const attachment_leg_glide_rr_17 = {"parentSocket": "frame-leg-rr-bottom", "localStart": [0.25, -0.42, -0.25], "localEnd": [0.25, -0.44, -0.25], "contactType": "butt", "embedDepth": 0.005, "overlap": 0.02, "gapTolerance": 0.0};
  const endpoint_leg_glide_rr_17 = makeAttachmentEndpoint(attachment_leg_glide_rr_17);
  const node_leg_glide_rr_17 = new THREE.Group();
  node_leg_glide_rr_17.name = "leg-glide-rr__pivot";
  node_leg_glide_rr_17.scale.set(1, 1, 1);
  if (endpoint_leg_glide_rr_17) {
    node_leg_glide_rr_17.position.copy(endpoint_leg_glide_rr_17.start);
    node_leg_glide_rr_17.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_leg_glide_rr_17.position.set(0.25, -0.01, -0.25);
    node_leg_glide_rr_17.rotation.set(0.0, 0.0, 0.0);
  }
  node_leg_glide_rr_17.userData.sculptComponent = {"id": "leg-glide-rr", "parent": "frame-leg-rr", "primitive": "cylinder", "level": "micro", "topologyClass": "conforming-shell", "topologyRationale": "Dark plastic foot at the bottom of the rear-right leg.", "transform": {"position": [0.25, -0.01, -0.25], "rotation": [0, 0, 0]}, "geometry": {"primitive": "cylinder", "size": [0.025, 0.025, 0.02]}, "dimensions": {"width": 0.025, "height": 0.025, "depth": 0.02}, "materialIds": ["glides"], "material": "glides", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}}, "evidenceRefs": ["glides-detail"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 26, 1.0)", "secondaryAlbedo": "rgba(0, 0, 0, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.85, "primaryMaterialId": "glides"}, "attachment": {"parentSocket": "frame-leg-rr-bottom", "localStart": [0.25, -0.42, -0.25], "localEnd": [0.25, -0.44, -0.25], "contactType": "butt", "embedDepth": 0.005, "overlap": 0.02, "gapTolerance": 0.0}};
  node_leg_glide_rr_17.userData.actionProfile = {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}};
  (nodes["frame-leg-rr"] ?? root).add(node_leg_glide_rr_17);
  nodes["leg-glide-rr"] = node_leg_glide_rr_17;
  const mesh_leg_glide_rr_17Geometry = endpoint_leg_glide_rr_17
    ? new THREE.CylinderGeometry(endpoint_leg_glide_rr_17.endRadius, endpoint_leg_glide_rr_17.baseRadius, endpoint_leg_glide_rr_17.length, 8, 4)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 4);
  if (!endpoint_leg_glide_rr_17) {
    mesh_leg_glide_rr_17Geometry.scale(0.025, 0.025, 0.02);
  }
  const mesh_leg_glide_rr_17 = new THREE.Mesh(
    mesh_leg_glide_rr_17Geometry,
    materialMap["glides"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leg_glide_rr_17.name = "leg-glide-rr";
  if (endpoint_leg_glide_rr_17) {
    mesh_leg_glide_rr_17.position.copy(endpoint_leg_glide_rr_17.midpoint);
    mesh_leg_glide_rr_17.quaternion.copy(endpoint_leg_glide_rr_17.quaternion);
  }
  mesh_leg_glide_rr_17.castShadow = options.castShadow ?? true;
  mesh_leg_glide_rr_17.receiveShadow = options.receiveShadow ?? true;
  mesh_leg_glide_rr_17.userData.sculptComponent = {"id": "leg-glide-rr", "parent": "frame-leg-rr", "primitive": "cylinder", "level": "micro", "topologyClass": "conforming-shell", "topologyRationale": "Dark plastic foot at the bottom of the rear-right leg.", "transform": {"position": [0.25, -0.01, -0.25], "rotation": [0, 0, 0]}, "geometry": {"primitive": "cylinder", "size": [0.025, 0.025, 0.02]}, "dimensions": {"width": 0.025, "height": 0.025, "depth": 0.02}, "materialIds": ["glides"], "material": "glides", "actionProfile": {"animationRole": "static-component", "pivot": {"mode": "static", "position": [0, 0, 0], "confidence": 0.95}, "collider": {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false}, "destruction": {"breakable": false, "fractureGroup": "frame"}}, "evidenceRefs": ["glides-detail"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 26, 1.0)", "secondaryAlbedo": "rgba(0, 0, 0, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.85, "primaryMaterialId": "glides"}, "attachment": {"parentSocket": "frame-leg-rr-bottom", "localStart": [0.25, -0.42, -0.25], "localEnd": [0.25, -0.44, -0.25], "contactType": "butt", "embedDepth": 0.005, "overlap": 0.02, "gapTolerance": 0.0}};
  node_leg_glide_rr_17.add(mesh_leg_glide_rr_17);
  meshes["leg-glide-rr"] = mesh_leg_glide_rr_17;
  colliders["leg-glide-rr"] = {"type": "box", "size": [0.1, 0.1, 0.1], "isTrigger": false};
  destructionGroups["frame"] ??= [];
  destructionGroups["frame"].push(node_leg_glide_rr_17);

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createNavyUpholsteredChairLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Navy upholstered chair look-dev lights";
  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xfff0d6 : 0xf2f4ff,
    0x363b42,
    mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85,
  );
  lights.add(hemi);
  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffcf8a : 0xfff4e8,
    mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15,
  );
  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);
  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);
  else key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = [{"approach": "three-point lighting matched to harness defaults; ACES Filmic tone mapping with exposure 1.0; contact shadow under the chair.", "keyLight": {"id": "key", "type": "directional", "intensity": 1.6, "direction": [2.5, 3.5, 2.5], "color": "#ffffff", "castsShadows": true, "shadowMapSize": 2048}, "fillLight": {"id": "fill", "type": "directional", "intensity": 0.5, "direction": [-2.5, 1.5, 1.5], "color": "#ffffff", "castsShadows": false}, "rimLight": {"id": "rim", "type": "directional", "intensity": 0.7, "direction": [0, 2.0, -3.0], "color": "#ffffff", "castsShadows": false}, "ambientLight": 0.25, "environmentLight": {"type": "studio-rim-only", "intensity": 0.4}, "toneMapping": "ACESFilmic", "exposure": 1.0, "backgroundColor": "#ffffff", "contactShadow": {"enabled": true, "opacity": 0.7, "blur": 0.015, "distance": 0.02}, "groundShadow": {"enabled": true, "plane": "y=-0.44", "softness": 0.04}, "notes": "Single-view photo cannot reliably disentangle original studio lighting from material response. Using harness defaults; verify in surface-pass review. ACES Filmic tone mapping with exposure 1.0; soft contact shadow under each leg."}, {"id": "neutral-light", "approach": "Neutral-light render to verify material readability without reference lighting.", "toneMapping": "ACESFilmic", "exposure": 1.0, "ambientLight": 0.5, "keyLight": {"type": "directional", "intensity": 0.8, "direction": [0, 1, 0], "color": "#ffffff", "castsShadows": false}, "groundShadow": {"enabled": true, "softness": 0.05}, "notes": "Used in surface-pass review to verify albedo palette and roughness variation without skew from reference direction. Soft contact shadow under chair legs."}, {"id": "grazing-light", "approach": "Grazing-angle close-up to expose flat normals, uniform roughness, and plastic highlights.", "toneMapping": "ACESFilmic", "exposure": 1.0, "ambientLight": 0.2, "keyLight": {"type": "directional", "intensity": 1.0, "direction": [3.0, 0.2, 0], "color": "#ffffff", "castsShadows": false}, "groundShadow": {"enabled": true, "softness": 0.03}, "notes": "Verifies fabric weave micro-relief and brushed-metal anisotropy. Soft contact shadow under the legs."}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createNavyUpholsteredChairEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

// Plan 1.3 §3.2 — auto-framing by bounding box. The Divine Eye can only compare a
// render to the reference if the object is FRAMED consistently (an object framed
// differently scores as wrong even when its shape is right). This positions the camera
// deterministically from the object's bounding box so it fills the frame at a stable
// margin, and sets near/far to the object scale. Call after adding the model to the
// scene, and again on resize (after updating camera.aspect).
export function frameNavyUpholsteredChairCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (camera.fov * Math.PI) / 180;
  // distance so the largest object dimension fits vertically in the frame
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.01, distance - maxDim);
  camera.far = distance + maxDim * 2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Plan 1.3 §3.2c — PRESENTATION composer (DOF + bloom). CRITICAL (R-POSTFX): this is
// for the showcase/hero render ONLY. The Divine Eye's EVALUATION render MUST use a
// plain renderer with NO composer — bloom blows highlights and DOF blurs edges, which
// would corrupt the deterministic IoU/DCD/edge/blowout signals. Enable dof/bloom ONLY
// when the reference photo actually exhibits them (detect_reference_effects.py authorizes).
export function createNavyUpholsteredChairPresentationComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { dof?: boolean; bloom?: boolean; bloomStrength?: number; dofFocus?: number; dofAperture?: number } = {},
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (options.dof) {
    composer.addPass(new BokehPass(scene, camera, {
      focus: options.dofFocus ?? 10.0,
      aperture: options.dofAperture ?? 0.0002,
      maxblur: 0.01,
    }));
  }
  if (options.bloom) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    composer.addPass(new UnrealBloomPass(size, options.bloomStrength ?? 0.4, 0.4, 0.85));
  }
  return composer;
}

export function configureNavyUpholsteredChairRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createNavyUpholsteredChairInspectControls(
  camera: THREE.Camera,
  domElement: HTMLElement,
): OrbitControls {
  // View-dependent finishes only read correctly once the user orbits — their color
  // comes from the environment reflection, not albedo, so free rotation matters here.
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  controls.autoRotate = false;
  return controls;
}
