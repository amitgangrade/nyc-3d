import type { NavMode } from '../controls/CameraController';
import type { PresetName } from '../render/TimeOfDay';
import { PRESETS } from '../render/TimeOfDay';
import { PLACES, type Place } from './places';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export interface InfoCard { title: string; height: number; year: number; note: string | null; lonlat: [number, number] | null; link?: { href: string; label: string } }

/** Thin DOM layer: wires the static markup in index.html to callbacks. */
export class UI {
  onPreset?: (p: PresetName) => void;
  onHour?: (h: number) => void;
  onPlay?: (p: boolean) => void;
  onMode?: (m: NavMode) => void;
  onNorth?: () => void;
  onPlace?: (p: Place) => void;
  private playing = false;

  constructor() {
    document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) =>
      b.addEventListener('click', () => this.onPreset?.(b.dataset.preset as PresetName)));
    const slider = $<HTMLInputElement>('time-slider');
    slider.addEventListener('input', () => this.onHour?.(parseFloat(slider.value)));
    $('play').addEventListener('click', () => { this.setPlaying(!this.playing); this.onPlay?.(this.playing); });
    document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
      b.addEventListener('click', () => this.onMode?.(b.dataset.mode as NavMode)));
    $('compass').addEventListener('click', () => this.onNorth?.());
    $('help-toggle').addEventListener('click', () => this.toggleHelp());
    $('places-toggle').addEventListener('click', () => $('places').classList.toggle('collapsed'));
    $('info-close').addEventListener('click', () => this.showInfo(null));

    const list = $('places-list');
    for (const p of PLACES) {
      if (p.group) {
        const h = document.createElement('div');
        h.className = 'place-group';
        h.textContent = p.group;
        list.appendChild(h);
      }
      const b = document.createElement('button');
      b.className = 'place';
      b.innerHTML = `<span class="place-name">${p.name}</span>${p.sub ? `<span class="place-sub">${p.sub}</span>` : ''}`;
      b.addEventListener('click', () => this.onPlace?.(p));
      list.appendChild(b);
    }
    if (window.innerWidth < 700) $('places').classList.add('collapsed');
    try { if (localStorage.getItem('nyc3d.help') === 'hidden') $('help').classList.add('hidden'); } catch { /* ignore */ }
  }

  /** f: splash progress (splash hides at 1); total: overall streaming progress shown in a small pill afterwards */
  setLoading(f: number, text: string, total = f) {
    $('loading-bar').style.transform = `scaleX(${Math.min(1, f)})`;
    $('loading-text').textContent = text;
    if (f >= 1) setTimeout(() => $('loading').classList.add('done'), 300);
    const pill = $('stream');
    pill.textContent = text;
    pill.classList.toggle('show', f >= 1 && total < 1);
  }

  setHour(h: number) {
    $<HTMLInputElement>('time-slider').value = String(h);
    const hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
    const ampm = hh >= 12 ? 'PM' : 'AM';
    $('time-label').textContent = `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${ampm}`;
    // highlight the nearest preset
    let best: string = 'day', bd = 99;
    for (const [k, v] of Object.entries(PRESETS)) {
      const d = Math.abs(((h - v + 36) % 24) - 12);
      const dist = 12 - d;
      if (dist < bd) { bd = dist; best = k; }
    }
    document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) =>
      b.classList.toggle('active', b.dataset.preset === best && bd < 0.6));
  }

  setPlaying(p: boolean) {
    this.playing = p;
    $('play').classList.toggle('active', p);
    $('play').setAttribute('aria-label', p ? 'Pause time-lapse' : 'Play time-lapse');
    $('play').innerHTML = p ? ICON_PAUSE : ICON_PLAY;
  }

  setMode(m: NavMode) {
    document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
    document.body.dataset.mode = m;
    $('fly-hint').classList.toggle('show', m === 'fly');
  }

  setLocked(l: boolean) { $('fly-hint').textContent = l ? 'Mouse captured · Esc to release' : 'Click the view to steer with the mouse'; }

  toggleHelp() {
    const h = $('help');
    h.classList.toggle('hidden');
    try { localStorage.setItem('nyc3d.help', h.classList.contains('hidden') ? 'hidden' : 'shown'); } catch { /* ignore */ }
  }

  showInfo(c: InfoCard | null) {
    const el = $('info');
    if (!c) { el.classList.remove('show'); return; }
    $('info-title').textContent = c.title;
    const ft = Math.round(c.height / 0.3048);
    const rows: [string, string][] = [
      ['Height', `${Math.round(c.height)} m · ${ft.toLocaleString()} ft`],
      ['Est. floors', String(Math.max(1, Math.round(c.height / 3.8)))],
    ];
    if (c.year) rows.push(['Built', String(c.year)]);
    if (c.lonlat) rows.push(['Location', `${c.lonlat[1].toFixed(5)}, ${c.lonlat[0].toFixed(5)}`]);
    $('info-rows').innerHTML = rows.map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`).join('');
    $('info-note').textContent = c.note ?? 'Source: NYC Building Footprints (NYC Open Data)';
    const link = $<HTMLAnchorElement>('info-link');
    if (c.link) {
      link.href = c.link.href; link.textContent = c.link.label; link.style.display = '';
    } else if (c.lonlat) {
      link.href = `https://www.openstreetmap.org/?mlat=${c.lonlat[1]}&mlon=${c.lonlat[0]}#map=19/${c.lonlat[1]}/${c.lonlat[0]}`;
      link.textContent = 'Open in OpenStreetMap ↗'; link.style.display = '';
    } else link.style.display = 'none';
    el.classList.add('show');
  }

  setStatus(s: { fps: number; lon: number; lat: number; alt: number; heading: number }) {
    $('status').textContent = `${s.lat.toFixed(4)}°N ${Math.abs(s.lon).toFixed(4)}°W · alt ${Math.round(s.alt)} m · ${Math.round(s.fps)} fps`;
    $('compass-needle').style.transform = `rotate(${-s.heading}deg)`;
  }
}

const ICON_PLAY = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/></svg>';
