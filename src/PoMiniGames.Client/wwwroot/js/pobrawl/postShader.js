// postShader.js — the CA / vignette / radial-blur / broadcast-grade pass.
//
// Split out of game.js 2026-09-13. This is pure shader data: a uniforms table and
// two GLSL strings, with no reference to `this` and exactly one consumer
// (`_buildComposer`, which wraps it in a ShaderPass). It sat in the middle of
// game.js as 172 lines of GLSL between the gameplay constants and the class
// declaration, which is the one thing in that file that is not game logic at all.
//
// Deliberately NOT a mixin like vfx.js / cinematics.js: those move METHODS that
// close over match state, and need the prototype trick to keep `this` working.
// This moves a value, so a plain export is enough.

// ── Post-processing: CA + vignette + radial blur + broadcast grade ───────
// Runs after bloom, before OutputPass (so it operates on the linear HDR
// frame). uCA and uRadial are pulsed by hits and the KO flash; uDesat rides
// the KO lights-down blend (drains color, keeps the reds); the teal-shadow /
// warm-highlight grade and vignette are constant.
export const CAVignetteShader = {
  uniforms: {
    tDiffuse: { value: null },
    uCA: { value: 0 },
    uVignette: { value: 0.5 },
    uRadial: { value: 0 },
    uGrade: { value: 1.0 },
    uDesat: { value: 0 },
    // Film grain (idea #10): animated luminance-weighted noise. uGrain is the
    // amount (0 = off); uTime drives the per-frame hash so the grain crawls.
    //
    // 2026-08-07 (user request): OFF. At 0.04 the noise was weighted into the
    // shadows, and PoBrawl's fighters are mostly dark suits against a dark
    // hall — so instead of reading as film texture it read as a crawling
    // cross-hatch woven over the whole image, which is what it looked like on
    // the KO frames. The shader branch below is skipped entirely at 0, so this
    // costs nothing; raise it if the look is ever wanted back.
    uGrain: { value: 0.0 },
    uTime: { value: 0 },
    // ── Godrays / lens-flare uniforms (idea #10) ───────────────────
    // uGodrays     : intensity (0 = off). Drives the spotlight blade.
    // uGodraysOrig : screen-space origin of the shaft in UV (default 0.5,1.05 — top edge).
    // uGodraysDecay: per-step exponential falloff for the marching sample.
    // uGodraysTint : godray tint (warm yellow during KO).
    uGodrays: { value: 0 },
    uGodraysOrig: { value: [0.5, 1.05] },
    uGodraysDecay: { value: 0.94 },
    uGodraysTint: { value: [1.0, 0.94, 0.78] },
    // ── Speedlines (GFX/SOUND #3 / #2) ──────────────────────────────
    // Radial manga speedlines, drawn in screen space and masked away from the
    // frame centre so the fighters are never behind them. 0 = off and the
    // branch is skipped outright. Spiked for ~2 frames on a heavy impact and
    // held up through the super cinematic.
    uSpeed: { value: 0 },
    uSpeedTint: { value: [1.0, 0.97, 0.88] },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uCA;
    uniform float uVignette;
    uniform float uRadial;
    uniform float uGrade;
    uniform float uDesat;
    uniform float uGodrays;
    uniform vec2 uGodraysOrig;
    uniform float uGodraysDecay;
    uniform vec3 uGodraysTint;
    uniform float uGrain;
    uniform float uTime;
    uniform float uSpeed;
    uniform vec3 uSpeedTint;
    varying vec2 vUv;
    // Cheap hash for the film grain — no texture fetch.
    float hash21(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }
    void main() {
      vec2 off = (vUv - 0.5) * uCA * 0.012;
      float r = texture2D(tDiffuse, vUv + off).r;
      float g = texture2D(tDiffuse, vUv).g;
      float b = texture2D(tDiffuse, vUv - off).b;
      vec3 col = vec3(r, g, b);

      // Radial impact blur: a short streak toward the frame center. 4 extra
      // taps is enough at pulse strengths — it reads as a punch, not a filter.
      if (uRadial > 0.003) {
        vec2 dir = (vec2(0.5) - vUv) * uRadial * 0.05;
        vec3 acc = col;
        acc += texture2D(tDiffuse, vUv + dir * 1.0).rgb;
        acc += texture2D(tDiffuse, vUv + dir * 2.0).rgb;
        acc += texture2D(tDiffuse, vUv + dir * 3.0).rgb;
        acc += texture2D(tDiffuse, vUv + dir * 4.0).rgb;
        col = acc * 0.2;
      }

      // Godrays: sample along a line from each pixel toward the spotlight origin
      // (projected to screen space by the JS side). Each tap decays by
      // uGodraysDecay, so bright pixels near the origin smear outward as
      // the blade of light. 16 taps is cheap and reads as proper cinema.
      if (uGodrays > 0.003) {
        const int STEPS = 16;
        vec2 dir = (uGodraysOrig - vUv) / float(STEPS);
        float weight = 0.0;
        vec3 acc = vec3(0.0);
        float w = 1.0;
        vec2 p = vUv;
        for (int i = 0; i < STEPS; i++) {
          p += dir;
          vec3 s = texture2D(tDiffuse, p).rgb;
          // Threshold the sample so the lit pixels (spotlight + ring trim)
          // contribute most; the dim arena walls contribute little.
          float l = max(max(s.r, s.g), s.b);
          float mask = smoothstep(0.78, 1.05, l);
          acc += s * w * mask;
          weight += w * mask;
          w *= uGodraysDecay;
        }
        if (weight > 0.0001) {
          vec3 blade = acc / weight;
          col += blade * uGodrays * uGodraysTint;
        }
      }

      // Speedlines: radial streaks fanning out from the frame centre. The
      // angle is quantised into lanes, each lane hashed for its own brightness
      // and phase, so the fan is irregular the way an inked one is rather than
      // a clean starburst. Added BEFORE the grade so the grade's shoulder rolls
      // the hot ends of the lines off instead of leaving them clipped white.
      if (uSpeed > 0.003) {
        vec2 sd = vUv - 0.5;
        float srad = length(sd) * 2.0;
        float sang = atan(sd.y, sd.x) * 0.15915494 + 0.5;   // 0..1
        float lane = floor(sang * 110.0);
        float n = hash21(vec2(lane, 3.0));
        // ~40% of lanes carry a line; the rest stay empty so the fan breathes.
        float streak = smoothstep(0.58, 0.98, n);
        // Nothing inside 0.3 of centre (that is where the fighters are) and
        // nothing past the corners, so the lines read as framing, not overlay.
        float radMask = smoothstep(0.30, 0.92, srad) * (1.0 - smoothstep(1.24, 1.72, srad));
        // Each lane drifts outward on its own phase — static lines read as a
        // texture laid over the frame instead of speed through it.
        float phase = fract(n * 13.0 + uTime * 2.4);
        col += uSpeedTint * streak * radMask * uSpeed * (0.30 + 0.70 * phase);
      }

      // Broadcast grade: teal-pushed shadows, warm highlights, +saturation.
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col += vec3(0.008, 0.02, 0.038) * (1.0 - smoothstep(0.0, 0.4, lum)) * uGrade;
      col *= mix(vec3(1.0), vec3(1.05, 1.0, 0.93), smoothstep(0.3, 1.0, lum) * uGrade);
      col = mix(vec3(lum), col, 1.0 + 0.1 * uGrade);
      // Filmic S-curve contrast: crush the toe a touch and roll the shoulder so
      // the grade reads like a graded LUT rather than a flat colour shift. Only
      // the amount is dialled by uGrade — the shape is fixed.
      vec3 sc = col * col * (3.0 - 2.0 * col);   // smoothstep-shaped contrast
      col = mix(col, sc, 0.18 * uGrade);

      // KO drain: desaturate except strong reds (blood-red trim, red corner).
      if (uDesat > 0.003) {
        float keepRed = smoothstep(0.1, 0.4, col.r - max(col.g, col.b));
        vec3 drained = mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, keepRed);
        col = mix(col, drained, uDesat);
      }

      float d = distance(vUv, vec2(0.5));
      col *= 1.0 - smoothstep(0.55, 0.95, d) * uVignette;

      // Film grain (idea #10): animated monochrome noise, strongest in the
      // shadows (where sensor noise actually lives) and fading out of the
      // highlights so bright speculars stay clean. Two hashed samples offset
      // by the frame time keep it crawling rather than static-dithering.
      if (uGrain > 0.0001) {
        float g1 = hash21(vUv * vec2(1920.0, 1080.0) + fract(uTime) * 71.7);
        float grain = (g1 - 0.5);
        float shadowW = 1.0 - smoothstep(0.0, 0.55, lum); // more grain in darks
        col += grain * uGrain * (0.35 + 0.65 * shadowW);
      }
      gl_FragColor = vec4(col, 1.0);
    }`,
};
