import { GLSL_COMMON } from './common.glsl';

/** Analytic, art-directed sky: gradient + sun + clouds + stars + moon + city glow. */
export const SKY_UNIFORMS_GLSL = /* glsl */ `
uniform vec3 uSunDir; uniform vec3 uMoonDir;
uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uHorizonSun;
uniform vec3 uSunColor; uniform float uSunIntensity;
uniform vec3 uCloudLight; uniform float uNight; uniform float uLights; uniform float uTime;
uniform float uClouds;
`;

export const SKY_FN_GLSL = /* glsl */ `
${GLSL_COMMON}
vec3 skyGradient(vec3 d){
  float y = d.y;
  vec2 hd = normalize(d.xz + 1e-5), hs = normalize(uSunDir.xz + 1e-5);
  float toward = dot(hd, hs) * 0.5 + 0.5;
  vec3 hor = mix(uHorizon, uHorizonSun, pow(toward, 3.0));
  float t = pow(1.0 - clamp(y, 0.0, 1.0), 3.2);
  vec3 col = mix(uZenith, hor, t);
  // thin bright band right on the horizon
  col = mix(col, hor * 1.15, pow(1.0 - clamp(abs(y) * 6.0, 0.0, 1.0), 4.0) * 0.5);
  if (y < 0.0) col = mix(col, uHorizon * 0.7, smoothstep(0.0, -0.15, y));
  return col;
}

vec3 starField(vec3 d){
  vec3 p = d * 180.0;
  vec3 c = floor(p);
  vec3 f = fract(p) - 0.5;
  float r = h31(c);
  if (r < 0.972) return vec3(0.0);
  vec3 off = (h33(c) - 0.5) * 0.55;
  float dist = length(f - off);
  float b = smoothstep(0.17, 0.0, dist) * pow((r - 0.972) / 0.028, 2.0);
  float tw = 0.7 + 0.3 * sin(uTime * (1.5 + r * 4.0) + r * 100.0);
  vec3 tint = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.9, 0.75), h31(c + 7.0));
  return tint * b * tw * 2.5;
}

vec4 clouds(vec3 d){
  if (d.y <= 0.005) return vec4(0.0);
  vec2 p = d.xz / (d.y + 0.08) * 1.6 + vec2(uTime * 0.004, uTime * 0.0015);
  float n = fbm(p * 1.1);
  float n2 = fbm(p * 3.3 + 4.0);
  float cov = mix(0.62, 0.48, uClouds);
  float a = smoothstep(cov, cov + 0.28, n * 0.75 + n2 * 0.35);
  a *= smoothstep(0.01, 0.18, d.y);
  // brighter towards the sun, darker cores
  float sunSide = pow(max(dot(normalize(d), uSunDir), 0.0), 6.0);
  vec3 lit = uCloudLight * (0.55 + 0.45 * n2) * (0.6 + 0.4 * (1.0 - uNight));
  lit += uCloudLight * sunSide * 0.8 * (1.0 - uNight);
  vec3 cityGlow = vec3(0.16, 0.085, 0.05) * uLights * (0.8 + 0.6 * smoothstep(0.4, 0.0, d.y));
  vec3 moonLit = vec3(0.05, 0.06, 0.09) * pow(max(dot(normalize(d), uMoonDir), 0.0), 4.0);
  vec3 col = mix(lit, cityGlow + moonLit + lit * 0.05, uNight);
  return vec4(col, a * 0.85);
}

vec3 skyColor(vec3 d, bool withDiscs){
  d = normalize(d);
  vec3 col = skyGradient(d);
  float sd = max(dot(d, uSunDir), 0.0);
  float sunUp = smoothstep(-0.12, 0.02, uSunDir.y);
  // Mie-like glow
  col += uSunColor * sunUp * (pow(sd, 6.0) * 0.18 + pow(sd, 48.0) * 0.45 + pow(sd, 400.0) * 1.2) * (0.35 + 0.15 * uSunIntensity);
  if (withDiscs) col += uSunColor * smoothstep(0.99985, 0.99993, sd) * 40.0 * sunUp;

  // night sky
  if (uNight > 0.0) {
    float hv = clamp(d.y, 0.0, 1.0);
    col += starField(d) * uNight * smoothstep(0.03, 0.35, hv) * (withDiscs ? 1.0 : 0.0);
    float md = max(dot(d, uMoonDir), 0.0);
    vec3 moonCol = vec3(0.95, 0.93, 0.86);
    if (withDiscs) {
      float disc = smoothstep(0.99993, 0.99996, md);
      // faint maria
      vec3 mp = d - uMoonDir;
      float maria = vnoise(mp.xy * 1500.0) * 0.25 + vnoise(mp.yz * 900.0) * 0.2;
      col = mix(col, moonCol * (2.4 - maria * 2.0), disc * uNight);
    }
    col += vec3(0.25, 0.3, 0.42) * (pow(md, 900.0) * 0.6 + pow(md, 40.0) * 0.06) * uNight;
    // light dome over the city
    col += vec3(0.22, 0.12, 0.07) * uLights * pow(1.0 - hv, 7.0) * 0.55;
  }

  vec4 c = clouds(d);
  col = mix(col, c.rgb, c.a);
  return col;
}
`;
