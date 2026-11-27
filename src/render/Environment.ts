import * as THREE from 'three';
import type { Atmosphere } from './TimeOfDay';
import { computeAtmosphere } from './TimeOfDay';
import { shared } from './uniforms';
import type { Sky } from './Sky';
import type { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

/** Applies an Atmosphere to lights, fog, exposure, bloom, sky uniforms and the env map. */
export class Environment {
  readonly key = new THREE.DirectionalLight(0xffffff, 3);
  readonly hemi = new THREE.HemisphereLight(0xffffff, 0x333333, 1);
  readonly fog = new THREE.FogExp2(0xffffff, 5e-5);
  atm!: Atmosphere;
  private lastEnvHour = -99;
  private lastEnvTime = 0;
  shadowExtent = 1500;

  constructor(private scene: THREE.Scene, private renderer: THREE.WebGLRenderer, private sky: Sky, private bloom: UnrealBloomPass) {
    const k = this.key;
    k.castShadow = true;
    k.shadow.mapSize.set(4096, 4096);
    k.shadow.bias = -0.00025;
    k.shadow.normalBias = 0.6;
    k.shadow.camera.near = 10;
    k.shadow.camera.far = 14000;
    scene.add(k, k.target, this.hemi);
    scene.fog = this.fog;
  }

  setHour(hour: number, force = false) {
    const a = (this.atm = computeAtmosphere(hour));
    shared.uSunDir.value.copy(a.sunDir);
    shared.uMoonDir.value.copy(a.moonDir);
    shared.uZenith.value.copy(a.zenith);
    shared.uHorizon.value.copy(a.horizon);
    shared.uHorizonSun.value.copy(a.horizonSun);
    shared.uSunColor.value.copy(a.sunColor);
    shared.uSunIntensity.value = a.sunIntensity;
    shared.uCloudLight.value.copy(a.cloudLight);
    shared.uNight.value = a.night;
    shared.uLights.value = a.lights;
    shared.uAmbient.value.copy(a.ambientSky).multiplyScalar(a.ambientIntensity);

    // key light: sun by day, moon by night
    const moonI = 0.42 * THREE.MathUtils.smoothstep(-a.sunElevation, 4, 10);
    if (a.sunElevation > -4) {
      this.key.color.copy(a.sunColor);
      this.key.intensity = a.sunIntensity;
      this.keyDir.copy(a.sunDir);
    } else {
      this.key.color.setRGB(0.62, 0.74, 1.0);
      this.key.intensity = moonI;
      this.keyDir.copy(a.moonDir);
    }
    this.hemi.color.copy(a.ambientSky);
    this.hemi.groundColor.copy(a.ambientGround);
    this.hemi.intensity = a.ambientIntensity;
    this.fog.color.copy(a.fogColor);
    this.fog.density = a.fogDensity;
    this.renderer.toneMappingExposure = a.exposure;
    this.bloom.strength = a.bloom.strength;
    this.bloom.radius = a.bloom.radius;
    this.bloom.threshold = a.bloom.threshold;

    const now = performance.now();
    if (force || (Math.abs(hour - this.lastEnvHour) > 0.02 && now - this.lastEnvTime > 120)) {
      this.scene.environmentIntensity = a.envIntensity;
      this.sky.updateEnvironment(this.scene, new THREE.Color(0x15171a).multiplyScalar(0.4 + a.ambientIntensity * (1 - a.night)));
      this.lastEnvHour = hour; this.lastEnvTime = now;
    }
  }
  private keyDir = new THREE.Vector3(0, 1, 0);

  /** Haze is a ground-level effect: thin it out as the camera climbs so wide overviews stay crisp. */
  updateFog(altitude: number) {
    if (this.atm) this.fog.density = this.atm.fogDensity / (1 + Math.max(0, altitude) / 1500);
  }

  /** Keep the shadow frustum centred on what the camera looks at, sized by distance. */
  updateShadow(focus: THREE.Vector3, camDistance: number) {
    const ext = THREE.MathUtils.clamp(camDistance * 0.9, 250, 4000);
    this.shadowExtent = ext;
    const cam = this.key.shadow.camera;
    cam.left = -ext; cam.right = ext; cam.top = ext; cam.bottom = -ext;
    cam.updateProjectionMatrix();
    // snap to shadow texels to avoid shimmering while panning
    const texel = (2 * ext) / this.key.shadow.mapSize.x;
    const f = focus.clone();
    f.x = Math.round(f.x / texel) * texel; f.z = Math.round(f.z / texel) * texel; f.y = 0;
    this.key.target.position.copy(f);
    this.key.position.copy(f).addScaledVector(this.keyDir, 6000);
    // shadows only from the sun: a low full moon makes km-long shadows that read as artefacts
    this.key.castShadow = this.key.intensity > 0.02 && (this.atm?.sunElevation ?? 90) > -4;
  }
}
