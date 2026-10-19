// Inline 3D previews of Blender work.
//
// After each Blender tool call the MCP proxy snapshots the scene as GLB and
// sends a blender_preview message. StatusManager keeps the newest one for the
// turn and, when the turn ends, adds it to the timeline as a `blender_preview`
// item: a small always-visible viewer at the bottom of the turn.
//
// Previews mount when they scroll into view. At most MAX_LIVE_VIEWERS WebGL
// contexts are live; the least recently shown one is replaced by a still of
// its last frame.
//
// Animated previews (a rig being animated) get a play/pause bar with a
// scrubber; they start playing as soon as the animation arrives.
//
// three.js loads on demand from jsDelivr (like marked/highlight.js), so the
// viewer ships with the UI alone: no bundling step or Electron change. The
// import URLs are built at runtime so esbuild leaves them external.
import { escapeHtml } from './utils.js';

const THREE_VERSION = '0.170.0';
const CDN = `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}`;
// The +esm builds of the addons import three from exactly `${CDN}/+esm`, so
// they share one three instance with the viewer.
const THREE_MODULES = [
  `${CDN}/+esm`,
  `${CDN}/examples/jsm/loaders/GLTFLoader.js/+esm`,
  `${CDN}/examples/jsm/controls/OrbitControls.js/+esm`,
  `${CDN}/examples/jsm/environments/RoomEnvironment.js/+esm`,
];

let threePromise = null;
function loadThree() {
  threePromise ??= Promise.all(THREE_MODULES.map((url) => import(url)))
    .then(([THREE, { GLTFLoader }, { OrbitControls }, { RoomEnvironment }]) => ({ THREE, GLTFLoader, OrbitControls, RoomEnvironment }))
    .catch((error) => {
      threePromise = null; // allow a retry, e.g. after going back online
      throw error;
    });
  return threePromise;
}

const MAX_LIVE_VIEWERS = 4;

// Studio floor under the model: grid lines and a soft pool of light, both
// fading out with distance so the floor melts into the dark background.
const FLOOR_VERTEX = `
varying vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;
const FLOOR_FRAGMENT = `
uniform vec3 uCenter;
uniform float uCell;
uniform float uRadius;
varying vec3 vWorld;
void main() {
  vec2 coord = vWorld.xz / uCell;
  vec2 grid = abs(fract(coord - 0.5) - 0.5) / fwidth(coord);
  float line = 1.0 - min(min(grid.x, grid.y), 1.0);
  float d = length(vWorld.xz - uCenter.xz) / uRadius;
  float fade = 1.0 - smoothstep(0.15, 1.0, d);
  float pool = 1.0 - smoothstep(0.0, 0.6, d);
  float alpha = line * 0.16 * fade + pool * 0.10;
  gl_FragColor = vec4(vec3(0.85), alpha);
}`;

let getBaseUrl = () => '';
const liveViewers = []; // least recently shown first
let visibilityObserver = null;

// Supersample: 2x even when the page is zoomed out (devicePixelRatio < 1
// would otherwise render the small stage at a fraction of its size). Capped
// at 2x: 3x on high-DPI screens multiplied every viewer's buffers by 2.25.
function renderPixelRatio() {
  return 2;
}

function previewUrl(path) {
  return `${getBaseUrl()}/blender-preview-file?path=${encodeURIComponent(path)}`;
}

// Free a texture, including its decoded image. GLTFLoader decodes textures
// into ImageBitmaps, which three.js never closes; their pixels live outside
// the JS heap, so GC is slow to reclaim them and a live preview reloading a
// textured model every Blender step ran the window out of memory.
function disposeTexture(texture) {
  texture.dispose();
  const image = texture.source?.data ?? texture.image;
  if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close();
}

// Largest texture side kept for a preview. The stage is a few hundred pixels
// tall; a model's 4096² maps decoded at full size held ~64 MB each in the
// window and again on the GPU.
const MAX_TEXTURE_SIZE = 1024;

function texturesOf(root) {
  const textures = new Set();
  root.traverse((object) => {
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material) continue;
      for (const value of Object.values(material)) {
        if (value && value.isTexture) textures.add(value);
      }
    }
  });
  return textures;
}

// Downscale oversized decoded textures before their first upload.
async function shrinkTextures(root) {
  if (typeof ImageBitmap === 'undefined' || typeof createImageBitmap === 'undefined') return;
  const jobs = new Map(); // source -> promise (textures can share an image)
  for (const texture of texturesOf(root)) {
    const source = texture.source;
    const image = source?.data;
    if (!(image instanceof ImageBitmap) || jobs.has(source)) continue;
    const scale = MAX_TEXTURE_SIZE / Math.max(image.width, image.height);
    if (!(scale < 1)) continue;
    jobs.set(source, createImageBitmap(image, {
      resizeWidth: Math.max(1, Math.round(image.width * scale)),
      resizeHeight: Math.max(1, Math.round(image.height * scale)),
      resizeQuality: 'high',
      // Same as GLTFLoader's decode, so the pixels are unchanged otherwise.
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    }).then((small) => {
      source.data = small;
      source.needsUpdate = true;
      image.close();
    }).catch(() => {})); // keep the full-size image
  }
  await Promise.all(jobs.values());
}

// Free the GPU resources of a three.js object tree.
function disposeObject(root) {
  root.traverse((object) => {
    object.geometry?.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material) continue;
      for (const value of Object.values(material)) {
        if (value && value.isTexture) disposeTexture(value);
      }
      material.dispose();
    }
  });
}

const PLAY_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.8v10.4L13 8z" fill="currentColor"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5h3v11H4zm5 0h3v11H9z" fill="currentColor"/></svg>';

/** Play/pause button, scrubber and time for an animated preview. */
export class AnimationControls {
  constructor(container, { onToggle, onSeek }) {
    this.el = document.createElement('div');
    this.el.className = 'blender-preview-controls';
    this.el.innerHTML = '<button type="button" class="bpc-play"></button>'
      + '<input type="range" class="bpc-scrub" min="0" step="0.01" value="0" aria-label="Animation time">'
      + '<span class="bpc-time"></span>';
    this.button = this.el.querySelector('.bpc-play');
    this.scrub = this.el.querySelector('.bpc-scrub');
    this.time = this.el.querySelector('.bpc-time');
    this.button.addEventListener('click', () => onToggle());
    this.scrub.addEventListener('input', () => onSeek(Number(this.scrub.value)));
    container.appendChild(this.el);
  }

  update(time, duration, playing) {
    this.scrub.max = String(duration);
    this.scrub.value = String(time);
    this.scrub.style.setProperty('--progress', `${duration > 0 ? (time / duration) * 100 : 0}%`);
    this.time.textContent = `${time.toFixed(1)} / ${duration.toFixed(1)}s`;
    if (this.button.dataset.playing !== String(playing)) {
      this.button.dataset.playing = String(playing);
      this.button.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
      this.button.setAttribute('aria-label', playing ? 'Pause animation' : 'Play animation');
    }
  }

  remove() {
    this.el.remove();
  }
}

class PreviewViewer {
  constructor(container) {
    this.container = container;
    this.stage = container.querySelector('.blender-preview-stage');
    this.disposed = false;
    // Animation state outlives model reloads, so a live preview keeps its
    // play/pause state and time.
    this.playing = false;
    this.animationTime = 0;
  }

  setMessage(text) {
    this.stage.innerHTML = `<div class="blender-preview-message">${escapeHtml(text)}</div>`;
  }

  async start() {
    if (!this.stage.style.backgroundImage) this.setMessage('Loading model…');
    let modules;
    try {
      modules = await loadThree();
    } catch {
      if (!this.disposed) this.setMessage('3D viewer unavailable (could not load three.js).');
      return;
    }
    if (this.disposed) return;
    this.modules = modules;
    await this.load(this.container.dataset.path);
  }

  // Show the GLB at `path`, replacing the current model. Live previews call
  // this on every Blender step; the camera keeps its angle, re-aimed at the
  // new model. Calls made while a load is in flight collapse to the newest.
  async load(path) {
    this.container.dataset.path = path;
    if (!this.modules || this.disposed) return;
    if (this.loading) {
      this.pendingPath = path;
      return;
    }
    this.loading = true;
    try {
      let gltf;
      try {
        gltf = await new this.modules.GLTFLoader().loadAsync(previewUrl(path));
      } catch {
        if (!this.disposed && !this.renderer) this.setMessage('Preview no longer available.');
        return;
      }
      if (!this.disposed) await shrinkTextures(gltf.scene);
      if (this.disposed) {
        disposeObject(gltf.scene);
        return;
      }
      if (!this.renderer) this.setup();
      this.showModel(gltf.scene, gltf.animations || []);
    } finally {
      this.loading = false;
      const next = this.pendingPath;
      this.pendingPath = null;
      if (next && next !== path && !this.disposed) this.load(next);
    }
  }

  showModel(model, clips = []) {
    const { THREE } = this.modules;
    // First view: a three-quarter angle just above eye level, from the front.
    // Models built facing Blender -Y face +Z here; Roblox rigs face -Z.
    const direction = this.model
      ? this.camera.position.clone().sub(this.controls.target).normalize()
      : new THREE.Vector3(0.55, 0.3, clips.length ? -1 : 1).normalize();
    if (this.model) {
      this.scene.remove(this.model);
      disposeObject(this.model);
    }
    this.model = model;
    this.scene.add(model);

    model.traverse((object) => {
      if (object.isMesh) object.castShadow = true;
    });
    const box = new THREE.Box3().setFromObject(model);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 1e-3);
    this.placeStage(box, sphere.center, radius, direction);
    this.camera.near = radius / 100;
    this.camera.far = radius * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).add(direction.clone().multiplyScalar(this.fitDistance(box, sphere.center, direction, radius)));
    this.controls.update();
    this.showAnimation(model, clips);
  }

  // Put the floor under the model and aim the lights at it: the key light
  // high on the camera's side (a short shadow under the model), the rim light
  // behind it.
  placeStage(box, center, radius, direction) {
    const { THREE } = this.modules;
    const floorY = box.min.y;
    const extent = radius * 6;
    this.floor.position.set(center.x, floorY, center.z);
    this.floor.scale.setScalar(extent);
    this.shadowCatcher.position.set(center.x, floorY + radius * 0.001, center.z);
    this.shadowCatcher.scale.setScalar(extent);
    const uniforms = this.floor.material.uniforms;
    uniforms.uCenter.value.set(center.x, floorY, center.z);
    uniforms.uRadius.value = radius * 3;
    // About three grid cells across a character-sized model.
    uniforms.uCell.value = Math.pow(2, Math.round(Math.log2(Math.max(radius * 0.6, 1e-3))));

    const up = new THREE.Vector3(0, 1, 0);
    const side = new THREE.Vector3().crossVectors(up, direction).normalize();
    const flat = new THREE.Vector3(direction.x, 0, direction.z).normalize();
    this.keyLight.position.copy(center)
      .addScaledVector(flat, radius * 1.4).addScaledVector(side, radius * 0.9).addScaledVector(up, radius * 3.5);
    this.keyLight.target.position.copy(center);
    this.rimLight.position.copy(center).addScaledVector(flat, -radius * 2.5).addScaledVector(up, radius * 1.5);
    this.rimLight.target.position.copy(center);
    const shadowCamera = this.keyLight.shadow.camera;
    shadowCamera.left = shadowCamera.bottom = -radius * 1.8;
    shadowCamera.right = shadowCamera.top = radius * 1.8;
    shadowCamera.near = radius * 0.1;
    shadowCamera.far = radius * 8;
    shadowCamera.updateProjectionMatrix();
    this.keyLight.shadow.radius = 6;
  }

  // Closest camera distance along `direction` at which every corner of the
  // box fits the view (height and width) with a small margin, so the model
  // fills the stage whatever its aspect.
  fitDistance(box, center, direction, radius) {
    const { THREE } = this.modules;
    const margin = 0.85;
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * margin;
    const tanH = tanV * this.camera.aspect;
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), direction).normalize();
    const up = new THREE.Vector3().crossVectors(direction, right).normalize();
    let distance = radius * 0.5;
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          const corner = new THREE.Vector3(x, y, z).sub(center);
          const toward = corner.dot(direction); // how far the corner sits toward the camera
          distance = Math.max(distance,
            toward + Math.abs(corner.dot(up)) / tanV,
            toward + Math.abs(corner.dot(right)) / tanH);
        }
      }
    }
    return distance;
  }

  // Blender bakes one clip per moving object; they share the scene's frame
  // range, so they play together as one animation.
  showAnimation(model, clips) {
    this.mixer?.stopAllAction();
    this.mixer = null;
    if (!clips.length) {
      this.animationControls?.remove();
      this.animationControls = null;
      return;
    }
    // The animation just arrived: play it from the start. After that the
    // user's play/pause choice holds across live reloads.
    if (!this.animationControls) {
      this.playing = true;
      this.animationTime = 0;
    }
    const { THREE } = this.modules;
    this.mixer = new THREE.AnimationMixer(model);
    for (const clip of clips) this.mixer.clipAction(clip).play();
    this.duration = Math.max(...clips.map((clip) => clip.duration), 0);
    this.animationTime = Math.min(this.animationTime, this.duration);
    this.mixer.setTime(this.animationTime);
    this.controls.autoRotate = false; // hold still so the motion is easy to follow
    this.animationControls ??= new AnimationControls(this.container, {
      onToggle: () => {
        this.playing = !this.playing;
        this.animationControls.update(this.animationTime, this.duration, this.playing);
      },
      onSeek: (time) => {
        this.animationTime = time;
        this.mixer?.setTime(time);
        this.animationControls.update(time, this.duration, this.playing);
      },
    });
    this.animationControls.update(this.animationTime, this.duration, this.playing);
  }

  advanceAnimation(delta) {
    if (!this.mixer || !this.playing || !(this.duration > 0)) return;
    this.animationTime = (this.animationTime + delta) % this.duration;
    this.mixer.setTime(this.animationTime);
    this.animationControls?.update(this.animationTime, this.duration, true);
  }

  setup() {
    const { THREE, OrbitControls, RoomEnvironment } = this.modules;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(renderPixelRatio());
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = renderer;

    // Studio lighting: soft image-based fill, a shadow-casting key light from
    // the front right and a cool rim light from behind.
    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    scene.environment = pmrem.fromScene(room, 0.04).texture;
    scene.environmentIntensity = 0.55;
    room.dispose?.();
    pmrem.dispose();
    const key = new THREE.DirectionalLight(0xfff4e8, 2.6);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.02;
    scene.add(key, key.target);
    const rim = new THREE.DirectionalLight(0xcfe0ff, 1.4);
    scene.add(rim, rim.target);
    this.keyLight = key;
    this.rimLight = rim;

    const floorGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.floor = new THREE.Mesh(floorGeometry, new THREE.ShaderMaterial({
      vertexShader: FLOOR_VERTEX,
      fragmentShader: FLOOR_FRAGMENT,
      uniforms: { uCenter: { value: new THREE.Vector3() }, uCell: { value: 1 }, uRadius: { value: 10 } },
      transparent: true,
      depthWrite: false,
    }));
    this.shadowCatcher = new THREE.Mesh(floorGeometry, new THREE.ShadowMaterial({ opacity: 0.45 }));
    this.shadowCatcher.receiveShadow = true;
    scene.add(this.floor, this.shadowCatcher);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
    this.camera = camera;
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 1.5;
    controls.addEventListener('start', () => { controls.autoRotate = false; });
    this.controls = controls;

    this.stage.innerHTML = '';
    this.stage.style.backgroundImage = '';
    this.stage.appendChild(renderer.domElement);
    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.stage);

    // Render only while on screen; tear down if the preview leaves the DOM
    // (chat switch or re-render).
    const clock = new THREE.Clock();
    const frame = () => {
      // Capped so time doesn't jump after the loop paused off screen.
      this.advanceAnimation(Math.min(clock.getDelta(), 0.1));
      controls.update();
      renderer.render(scene, camera);
    };
    this.intersectionObserver = new IntersectionObserver(([entry]) => {
      renderer.setAnimationLoop(entry.isIntersecting ? frame : null);
    });
    this.intersectionObserver.observe(this.stage);
    renderer.setAnimationLoop(frame);
    this.connectionTimer = setInterval(() => {
      if (!this.container.isConnected) closeViewer(this);
    }, 2000);
  }

  resize() {
    if (!this.renderer) return;
    const width = this.stage.clientWidth || 480;
    const height = this.stage.clientHeight || 260;
    this.renderer.setPixelRatio(renderPixelRatio());
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  // Keep the last frame as a still so a replaced preview doesn't go blank.
  snapshot() {
    if (!this.renderer || !this.container.isConnected) return '';
    try {
      this.renderer.render(this.scene, this.camera);
      // WebP: the canvas is supersampled, so a PNG still runs to megabytes.
      return this.renderer.domElement.toDataURL('image/webp', 0.85);
    } catch {
      return '';
    }
  }

  dispose() {
    this.disposed = true;
    const still = this.snapshot();
    clearInterval(this.connectionTimer);
    this.resizeObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    this.mixer?.stopAllAction();
    this.animationControls?.remove();
    this.controls?.dispose();
    this.scene?.environment?.dispose();
    if (this.scene) disposeObject(this.scene);
    if (this.renderer) {
      this.renderer.setAnimationLoop(null);
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      this.renderer.domElement.remove();
    }
    this.stage.innerHTML = '';
    if (still) this.stage.style.backgroundImage = `url("${still}")`;
  }
}

function closeViewer(viewer) {
  if (!viewer) return;
  viewer.dispose();
  const index = liveViewers.indexOf(viewer);
  if (index >= 0) liveViewers.splice(index, 1);
}

function openViewer(container) {
  const index = liveViewers.findIndex((viewer) => viewer.container === container);
  if (index >= 0) {
    liveViewers.push(...liveViewers.splice(index, 1));
    return;
  }
  const viewer = new PreviewViewer(container);
  liveViewers.push(viewer);
  while (liveViewers.length > MAX_LIVE_VIEWERS) {
    // Never evict the live preview of the running turn.
    closeViewer(liveViewers.find((candidate) => candidate.container !== live?.container));
  }
  viewer.start();
}

function createPreviewShell(path) {
  const el = document.createElement('div');
  el.className = 'message assistant message-blender-preview';
  if (typeof path !== 'string' || !path) return el;
  el.innerHTML = `<div class="message-content"><div class="blender-preview" data-path="${escapeHtml(path)}">`
    + '<div class="blender-preview-stage"></div></div></div>';
  return el;
}

// Each timeline item keeps its element (and so its viewer) across chat
// re-renders. Rebuilding it on every render (each turn end refolds the chat)
// re-downloaded and re-parsed every model in view and created a new WebGL
// context per preview each time.
const elementsByItem = new WeakMap();
// Containers visibilityObserver watches. The observer keeps its targets
// alive, so detached ones are unobserved by pruneBlenderPreviews.
const observedContainers = new Set();

function observeContainer(container) {
  if (!visibilityObserver) return;
  visibilityObserver.observe(container);
  observedContainers.add(container);
}

/** Timeline element for a `blender_preview` item, aligned like assistant text.
 *  An imported model is captioned with its name, so a stack of them reads. */
export function createBlenderPreviewElement(item) {
  const cached = item && typeof item === 'object' ? elementsByItem.get(item) : null;
  const cachedContainer = cached?.querySelector('.blender-preview');
  if (cachedContainer && cachedContainer.dataset.path === item.path) {
    observeContainer(cachedContainer);
    return cached;
  }
  const el = createPreviewShell(item?.path);
  const container = el.querySelector('.blender-preview');
  if (!container) return el;
  if (item && typeof item === 'object') elementsByItem.set(item, el);
  observeContainer(container);
  const name = typeof item?.name === 'string' ? item.name.trim() : '';
  if (name) {
    const caption = document.createElement('div');
    caption.className = 'blender-preview-caption';
    caption.textContent = name;
    container.appendChild(caption);
  }
  return el;
}

// ---------------------------------------------------------------------------
// Live preview: while a turn works in Blender, one viewer sits below the chat
// (after #messages, so new rows never push it up) and reloads the model after
// every step. When the turn ends it is removed and the final snapshot becomes
// the turn's blender_preview item.
//
// Each running chat keeps its newest snapshot; the dock shows the one of the
// chat on screen, so a Blender turn in another chat never replaces it.
// ---------------------------------------------------------------------------

const livePaths = new Map(); // chatId -> newest snapshot path of its running turn
let live = null; // { chatId, dock, container } — what the dock shows now

function liveDock() {
  const messages = document.getElementById('messages');
  if (!messages?.parentElement) return null;
  let dock = document.getElementById('blender-live-preview');
  if (!dock) {
    dock = document.createElement('div');
    dock.id = 'blender-live-preview';
    dock.className = 'messages blender-live-dock';
    messages.after(dock);
  }
  return dock;
}

function liveViewer() {
  return live ? liveViewers.find((viewer) => viewer.container === live.container) : null;
}

// Empty the dock, freeing its viewer.
function clearDock() {
  const viewer = liveViewer();
  live = null; // before closing, so eviction bookkeeping treats it as ordinary
  closeViewer(viewer);
  const dock = document.getElementById('blender-live-preview');
  if (dock) {
    dock.replaceChildren();
    dock.hidden = true;
  }
}

// Put chatId's newest snapshot in the dock.
function showInDock(chatId) {
  const path = livePaths.get(chatId);
  if (!path) {
    clearDock();
    return;
  }
  if (!live || live.chatId !== chatId || !live.container.isConnected) {
    clearDock();
    const dock = liveDock();
    if (!dock) return;
    const shell = createPreviewShell(path);
    dock.replaceChildren(shell);
    live = { chatId, dock, container: shell.querySelector('.blender-preview') };
  }
  live.dock.hidden = false;
  const viewer = liveViewer();
  if (!viewer) {
    live.container.dataset.path = path;
    openViewer(live.container);
  } else if (live.container.dataset.path !== path) {
    live.container.dataset.path = path;
    viewer.load(path);
  }
}

/** Show (or update) the running turn's live preview for chatId. */
export function showLiveBlenderPreview(chatId, activeChatId, preview) {
  if (!chatId || typeof preview?.path !== 'string' || !preview.path) return;
  livePaths.set(chatId, preview.path);
  if (chatId === activeChatId) showInDock(chatId);
}

/** Remove chatId's live preview (every chat's without one). */
export function clearLiveBlenderPreview(chatId) {
  if (chatId) livePaths.delete(chatId);
  else livePaths.clear();
  if (live && (!chatId || live.chatId === chatId)) clearDock();
}

/** Show the live preview of the chat on screen, if its turn has one. */
export function syncLiveBlenderPreview(activeChatId) {
  showInDock(activeChatId);
}

/** After a chat render: stop watching previews no longer in the page, and
 *  close their viewers now rather than on the next connection check. */
export function pruneBlenderPreviews() {
  for (const container of observedContainers) {
    if (container.isConnected) continue;
    visibilityObserver?.unobserve(container);
    observedContainers.delete(container);
  }
  for (const viewer of [...liveViewers]) {
    if (!viewer.container.isConnected) closeViewer(viewer);
  }
}

/** One-time setup: the local server base URL and lazy mounting on scroll. */
export function installBlenderPreviews(app) {
  getBaseUrl = () => app.getLocalServerBaseUrl?.() || '';
  if (typeof IntersectionObserver === 'undefined') return; // non-browser (unit tests)
  visibilityObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting && entry.target.isConnected) openViewer(entry.target);
    }
  }, { threshold: 0.5 });
}
