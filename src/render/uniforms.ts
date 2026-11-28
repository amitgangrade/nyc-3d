import * as THREE from 'three';

/**
 * Uniform objects shared (by reference) across every custom material, so a
 * single update per frame / per time-of-day change reaches all shaders.
 */
export const shared = {
  uTime: { value: 0 },
  uLights: { value: 0 },
  uNight: { value: 0 },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
  uZenith: { value: new THREE.Color() },
  uHorizon: { value: new THREE.Color() },
  uHorizonSun: { value: new THREE.Color() },
  uSunColor: { value: new THREE.Color() },
  uSunIntensity: { value: 1 },
  uCloudLight: { value: new THREE.Color() },
  uClouds: { value: 0.5 },
  uAmbient: { value: new THREE.Color() },
  /** region mask for procedural context land (r=1 where real data exists) */
  uRegionMask: { value: null as THREE.Texture | null },
  uRegionMaskRect: { value: new THREE.Vector4(-16000, -16000, 32000, 32000) },
  /** terrain patch (Central Park): flat land and harbour water are cut away where it is drawn */
  uPatchOn: { value: 0 },
  uPatchClass: { value: null as THREE.Texture | null },
  uPatchOrigin: { value: new THREE.Vector2() },
  uPatchU: { value: new THREE.Vector2(1, 0) },
  uPatchV: { value: new THREE.Vector2(0, 1) },
  uPatchSizeM: { value: new THREE.Vector2(1, 1) },
};

/** GLSL: true when a world xz point lies on a drawn terrain patch. */
export const PATCH_TEST_GLSL = /* glsl */ `
uniform float uPatchOn; uniform sampler2D uPatchClass; uniform vec2 uPatchOrigin; uniform vec2 uPatchU; uniform vec2 uPatchV; uniform vec2 uPatchSizeM;
bool onPatch(vec2 xz){
  if (uPatchOn < 0.5) return false;
  vec2 d = xz - uPatchOrigin;
  vec2 st = vec2(dot(d, uPatchU), dot(d, uPatchV)) / uPatchSizeM;
  if (st.x < 0.0 || st.y < 0.0 || st.x > 1.0 || st.y > 1.0) return false;
  return texture2D(uPatchClass, st).r < 0.99;
}`;
export type Shared = typeof shared;
