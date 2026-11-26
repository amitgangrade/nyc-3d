import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';

export type NavMode = 'map' | 'fly';
export interface View { target: THREE.Vector3; distance: number; heading: number; pitch: number }

const D2R = Math.PI / 180;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Two navigation modes sharing one camera:
 *  - map: MapControls (left-drag pan, right-drag orbit, wheel zoom-to-cursor) + keyboard
 *  - fly: free flight, WASD + mouse look (pointer lock), Q/E or Space/C for down/up
 * Plus animated fly-to for places and double-click.
 */
export class CameraController {
  mode: NavMode = 'map';
  readonly controls: MapControls;
  private keys = new Set<string>();
  private yaw = 0; private pitch = 0;
  private vel = new THREE.Vector3();
  private anim: null | { t: number; dur: number; from: View; to: View; lift: number } = null;
  flySpeedMul = 1;
  /** returns height of the surface under (x,z) or null */
  surfaceAt: (x: number, z: number, fromY: number) => number | null = () => null;
  onModeChange?: (m: NavMode) => void;
  onLockChange?: (locked: boolean) => void;

  constructor(readonly camera: THREE.PerspectiveCamera, readonly dom: HTMLElement) {
    const c = (this.controls = new MapControls(camera, dom));
    c.enableDamping = true;
    c.dampingFactor = 0.09;
    c.screenSpacePanning = false;
    c.zoomToCursor = true;
    c.minDistance = 12;
    c.maxDistance = 30000;
    c.maxPolarAngle = 88 * D2R;
    c.zoomSpeed = 1.2;
    c.rotateSpeed = 0.6;
    c.addEventListener('start', () => (this.anim = null));

    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea, select')) return;
      this.keys.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    dom.addEventListener('mousedown', (e) => {
      if (this.mode === 'fly' && e.button === 0 && document.pointerLockElement !== dom) dom.requestPointerLock?.();
    });
    document.addEventListener('pointerlockchange', () => this.onLockChange?.(document.pointerLockElement === dom));
    document.addEventListener('mousemove', (e) => {
      if (this.mode !== 'fly' || document.pointerLockElement !== dom) return;
      this.yaw -= e.movementX * 0.0021;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.0021, -1.5, 1.5);
    });
    dom.addEventListener('wheel', (e) => {
      if (this.mode !== 'fly') return;
      e.preventDefault();
      this.flySpeedMul = THREE.MathUtils.clamp(this.flySpeedMul * (e.deltaY > 0 ? 0.85 : 1.18), 0.05, 20);
    }, { passive: false });
  }

  get target() { return this.controls.target; }

  setMode(m: NavMode) {
    if (m === this.mode) return;
    this.anim = null;
    if (m === 'fly') {
      const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
      this.yaw = e.y; this.pitch = e.x;
      this.vel.set(0, 0, 0);
      this.controls.enabled = false;
    } else {
      if (document.pointerLockElement) document.exitPointerLock();
      // put the orbit target where we are looking (ground hit or ~400 m ahead)
      const dir = new THREE.Vector3(); this.camera.getWorldDirection(dir);
      let dist = 400;
      if (dir.y < -0.05) dist = Math.min(4000, (this.camera.position.y - 1) / -dir.y);
      this.controls.target.copy(this.camera.position).addScaledVector(dir, dist);
      this.controls.enabled = true;
      this.controls.update();
    }
    this.mode = m;
    this.onModeChange?.(m);
  }

  /** Current view as heading (compass deg, 0 = looking north) / pitch (deg down from horizon) / distance. */
  getView(): View {
    const off = this.camera.position.clone().sub(this.target);
    const dist = off.length();
    const heading = Math.atan2(-off.x, off.z) / D2R;
    const pitch = Math.asin(THREE.MathUtils.clamp(off.y / dist, -1, 1)) / D2R;
    return { target: this.target.clone(), distance: dist, heading, pitch };
  }

  heading(): number {
    const d = new THREE.Vector3(); this.camera.getWorldDirection(d);
    return Math.atan2(d.x, -d.z) / D2R;
  }

  setView(v: View) {
    const h = v.heading * D2R, p = v.pitch * D2R;
    const fwd = new THREE.Vector3(Math.sin(h), 0, -Math.cos(h));
    this.controls.target.copy(v.target);
    this.camera.position.copy(v.target).addScaledVector(fwd, -v.distance * Math.cos(p)).add(new THREE.Vector3(0, v.distance * Math.sin(p), 0));
    this.camera.lookAt(v.target);
    this.controls.update();
  }

  flyTo(to: Partial<View> & { target: THREE.Vector3 }, duration?: number) {
    this.setMode('map');
    const from = this.getView();
    const full: View = { target: to.target.clone(), distance: to.distance ?? from.distance, heading: to.heading ?? from.heading, pitch: to.pitch ?? from.pitch };
    // shortest way round
    let dh = ((full.heading - from.heading) % 360 + 540) % 360 - 180;
    full.heading = from.heading + dh;
    const hop = from.target.distanceTo(full.target);
    const lift = Math.max(0, hop * 0.45 - Math.max(from.distance, full.distance) * 0.5);
    this.anim = { t: 0, dur: duration ?? THREE.MathUtils.clamp(1.2 + hop / 2500, 1.2, 3.2), from, to: full, lift };
  }

  northUp() {
    const v = this.getView();
    if (this.mode === 'fly') { this.yaw = 0; return; }
    this.flyTo({ ...v, heading: 0 }, 0.9);
  }

  update(dt: number) {
    if (this.anim) {
      const a = this.anim;
      a.t = Math.min(1, a.t + dt / a.dur);
      const k = ease(a.t);
      const lerpLog = (x: number, y: number) => Math.exp(THREE.MathUtils.lerp(Math.log(x), Math.log(y), k));
      this.setView({
        target: a.from.target.clone().lerp(a.to.target, k),
        distance: lerpLog(a.from.distance, a.to.distance) + a.lift * Math.sin(Math.PI * k),
        heading: THREE.MathUtils.lerp(a.from.heading, a.to.heading, k),
        pitch: THREE.MathUtils.lerp(a.from.pitch, a.to.pitch, k),
      });
      if (a.t >= 1) this.anim = null;
      return;
    }
    if (this.mode === 'map') this.updateMap(dt); else this.updateFly(dt);
  }

  private key(...codes: string[]) { return codes.some((c) => this.keys.has(c)); }

  private updateMap(dt: number) {
    const v = this.getView();
    const boost = this.key('ShiftLeft', 'ShiftRight') ? 3 : 1;
    const move = v.distance * 0.9 * dt * boost;
    const h = v.heading * D2R;
    const fwd = new THREE.Vector3(Math.sin(h), 0, -Math.cos(h));
    const right = new THREE.Vector3(Math.cos(h), 0, Math.sin(h));
    const delta = new THREE.Vector3();
    if (this.key('KeyW', 'ArrowUp')) delta.add(fwd);
    if (this.key('KeyS', 'ArrowDown')) delta.sub(fwd);
    if (this.key('KeyD', 'ArrowRight')) delta.add(right);
    if (this.key('KeyA', 'ArrowLeft')) delta.sub(right);
    let changed = false;
    if (delta.lengthSq()) { delta.normalize().multiplyScalar(move); v.target.add(delta); changed = true; }
    if (this.key('KeyQ')) { v.heading -= 70 * dt * boost; changed = true; }
    if (this.key('KeyE')) { v.heading += 70 * dt * boost; changed = true; }
    if (this.key('KeyR')) { v.pitch = Math.min(88, v.pitch + 45 * dt); changed = true; }
    if (this.key('KeyF')) { v.pitch = Math.max(2, v.pitch - 45 * dt); changed = true; }
    if (this.key('Equal', 'NumpadAdd', 'PageUp', 'KeyZ')) { v.distance = Math.max(12, v.distance * (1 - 1.6 * dt)); changed = true; }
    if (this.key('Minus', 'NumpadSubtract', 'PageDown', 'KeyX')) { v.distance = Math.min(30000, v.distance * (1 + 1.6 * dt)); changed = true; }
    if (changed) this.setView(v);
    this.controls.update();
    // keep the camera above roofs / ground
    const s = this.surfaceAt(this.camera.position.x, this.camera.position.z, this.camera.position.y + 600);
    const minY = (s ?? 1) + 6;
    if (this.camera.position.y < minY) {
      this.camera.position.y = minY;
      this.camera.lookAt(this.target);
    }
  }

  private updateFly(dt: number) {
    const boost = this.key('ShiftLeft', 'ShiftRight') ? 4 : 1;
    const ground = this.surfaceAt(this.camera.position.x, this.camera.position.z, this.camera.position.y + 600) ?? 1;
    const agl = Math.max(1, this.camera.position.y - ground);
    const speed = THREE.MathUtils.clamp(agl * 1.1, 18, 1600) * this.flySpeedMul * boost;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const want = new THREE.Vector3();
    if (this.key('KeyW', 'ArrowUp')) want.add(fwd);
    if (this.key('KeyS', 'ArrowDown')) want.sub(fwd);
    if (this.key('KeyD', 'ArrowRight')) want.add(right);
    if (this.key('KeyA', 'ArrowLeft')) want.sub(right);
    if (this.key('KeyE', 'Space')) want.y += 1;
    if (this.key('KeyQ', 'KeyC')) want.y -= 1;
    if (want.lengthSq()) want.normalize().multiplyScalar(speed);
    this.vel.lerp(want, 1 - Math.exp(-dt * 6));
    this.camera.position.addScaledVector(this.vel, dt);
    if (!document.pointerLockElement) {
      // gentle keyboard look when the mouse is not captured
      if (this.key('KeyJ')) this.yaw += 1.2 * dt;
      if (this.key('KeyL')) this.yaw -= 1.2 * dt;
      if (this.key('KeyI')) this.pitch = Math.min(1.5, this.pitch + 1.0 * dt);
      if (this.key('KeyK')) this.pitch = Math.max(-1.5, this.pitch - 1.0 * dt);
    }
    this.camera.quaternion.copy(q);
    const s = this.surfaceAt(this.camera.position.x, this.camera.position.z, this.camera.position.y + 2) ?? 1;
    if (this.camera.position.y < s + 2) { this.camera.position.y = s + 2; this.vel.y = Math.max(0, this.vel.y); }
    if (this.camera.position.y > 20000) this.camera.position.y = 20000;
  }
}
