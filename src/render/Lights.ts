import * as THREE from 'three';
import { shared } from './uniforms';

const LOGDEPTH_V = '#include <common>\n#include <logdepthbuf_pars_vertex>\n';
const LOGDEPTH_F = '#include <common>\n#include <logdepthbuf_pars_fragment>\n';

/** Ground glow pools + lamp heads for street lights (visible from dusk). */
/** points: x,z pairs (tile-local); ys: optional ground height per lamp; headH: lamp-head height above ground */
export function createStreetLights(points: Float32Array, origin: [number, number], ys?: Float32Array, headH = 7.5): THREE.Group {
  const n = points.length / 2;
  const group = new THREE.Group();
  group.position.set(origin[0], 0, origin[1]);
  if (!n) return group;

  // ---- glow pools: one quad per lamp
  const R = 13;
  const pos = new Float32Array(n * 12), uv = new Float32Array(n * 8), seed = new Float32Array(n * 4);
  const idx = new Uint32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const x = points[i * 2], z = points[i * 2 + 1], s = Math.random();
    const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (let k = 0; k < 4; k++) {
      pos.set([x + c[k][0] * R, (ys ? ys[i] : 1.0) + 0.3, z + c[k][1] * R], (i * 4 + k) * 3);
      uv.set(c[k], (i * 4 + k) * 2);
      seed[i * 4 + k] = s;
    }
    idx.set([i * 4, i * 4 + 2, i * 4 + 1, i * 4, i * 4 + 3, i * 4 + 2], i * 6);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  const pool = new THREE.Mesh(g, poolMaterial());
  pool.renderOrder = 5;
  group.add(pool);

  // ---- lamp heads
  const hp = new Float32Array(n * 3), hs = new Float32Array(n);
  for (let i = 0; i < n; i++) { hp.set([points[i * 2], (ys ? ys[i] : 1.0) + headH, points[i * 2 + 1]], i * 3); hs[i] = seed[i * 4]; }
  const hg = new THREE.BufferGeometry();
  hg.setAttribute('position', new THREE.BufferAttribute(hp, 3));
  hg.setAttribute('seed', new THREE.BufferAttribute(hs, 1));
  const heads = new THREE.Points(hg, headMaterial());
  heads.renderOrder = 6;
  group.add(heads);
  group.userData.kind = 'streetlights';
  return group;
}

let _pool: THREE.ShaderMaterial | null = null;
function poolMaterial() {
  return _pool ??= new THREE.ShaderMaterial({
    uniforms: { uLights: shared.uLights },
    vertexShader: LOGDEPTH_V + `
      attribute float seed; varying vec2 vUv; varying float vSeed;
      void main(){ vUv = uv; vSeed = seed; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      #include <logdepthbuf_vertex>
      }`,
    fragmentShader: LOGDEPTH_F + `
      uniform float uLights; varying vec2 vUv; varying float vSeed;
      void main(){
        #include <logdepthbuf_fragment>
        float r = length(vUv);
        if (r > 1.0) discard;
        float f = pow(1.0 - r, 2.2);
        vec3 c = vSeed < 0.62 ? vec3(1.0, 0.86, 0.66) : vec3(1.0, 0.58, 0.24);
        gl_FragColor = vec4(c * f * 0.42 * uLights, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}

let _head: THREE.ShaderMaterial | null = null;
function headMaterial() {
  return _head ??= new THREE.ShaderMaterial({
    uniforms: { uLights: shared.uLights, uPx: { value: 1 } },
    vertexShader: LOGDEPTH_V + `
      attribute float seed; varying float vSeed; uniform float uPx;
      void main(){
        vSeed = seed;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(700.0 / -mv.z, 1.0, 6.0) * uPx;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: LOGDEPTH_F + `
      uniform float uLights; varying float vSeed;
      void main(){
        #include <logdepthbuf_fragment>
        float r = length(gl_PointCoord - 0.5) * 2.0;
        if (r > 1.0) discard;
        vec3 c = vSeed < 0.62 ? vec3(1.0, 0.9, 0.75) : vec3(1.0, 0.65, 0.3);
        
        gl_FragColor = vec4(c * (1.0 - r * r) * 1.6 * uLights, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}

/** Blinking red aviation obstruction lights on tall roofs. */
export function createBeacons(points: number[]): THREE.Points {
  const g = new THREE.BufferGeometry();
  const seeds = new Float32Array(points.length / 3).map(() => Math.random());
  g.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  g.setAttribute('seed', new THREE.BufferAttribute(seeds, 1));
  const m = new THREE.ShaderMaterial({
    uniforms: { uLights: shared.uLights, uTime: shared.uTime },
    vertexShader: LOGDEPTH_V + `
      attribute float seed; varying float vSeed;
      void main(){ vSeed = seed; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(4000.0 / -mv.z, 1.5, 5.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: LOGDEPTH_F + `
      uniform float uLights; uniform float uTime; varying float vSeed;
      void main(){
        #include <logdepthbuf_fragment>
        float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard;
        float blink = smoothstep(0.55, 0.75, sin(uTime * 2.4 + vSeed * 0.8) * 0.5 + 0.5);
        gl_FragColor = vec4(vec3(1.0, 0.08, 0.04) * (1.0 - r) * 6.0 * blink * uLights, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const p = new THREE.Points(g, m);
  p.frustumCulled = false;
  p.renderOrder = 7;
  return p;
}

/** Generic warm glowing points (e.g. bridge "necklace" lights), lit from dusk. */
export function createGlowPoints(points: number[], color = new THREE.Color(1.0, 0.86, 0.6), size = 2200, rainbowPhase?: number[]): THREE.Points {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  g.setAttribute('phase', new THREE.Float32BufferAttribute(rainbowPhase ?? new Array(points.length / 3).fill(0), 1));
  const m = new THREE.ShaderMaterial({
    uniforms: { uLights: shared.uLights, uTime: shared.uTime, uColor: { value: color }, uSize: { value: size }, uRainbow: { value: rainbowPhase ? 1 : 0 } },
    vertexShader: LOGDEPTH_V + `
      uniform float uSize; uniform float uTime; uniform float uRainbow; uniform vec3 uColor;
      attribute float phase; varying vec3 vCol;
      vec3 hue(float h){ return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }
      void main(){
        vCol = mix(uColor, hue(fract(phase * 2.0 - uTime * 0.08)) * 0.85 + 0.15, uRainbow);
        vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(uSize / -mv.z, 1.2, 7.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: LOGDEPTH_F + `
      uniform float uLights; varying vec3 vCol;
      void main(){
        #include <logdepthbuf_fragment>
        float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard;
        gl_FragColor = vec4(vCol * (1.0 - r * r) * 2.6 * uLights, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const p = new THREE.Points(g, m);
  p.renderOrder = 7;
  return p;
}
