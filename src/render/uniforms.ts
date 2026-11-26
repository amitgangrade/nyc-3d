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
};
export type Shared = typeof shared;
