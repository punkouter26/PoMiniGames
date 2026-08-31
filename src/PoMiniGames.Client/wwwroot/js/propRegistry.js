// propRegistry.js — the Vibe3D-pattern prop/material registry for three.js
// games (§GFX-13).
//
// The Vibe3D contract (https://vibe-stack.github.io/vibe3d) is "files, not a
// black box": props install as readable sources, materials mount from a shared
// library (so a theme override never rebuilds the model), and stable runtime
// handles expose the moving parts. This module implements that contract for
// PoMiniGames so kit assets and our own props mount through ONE seam:
//
//   PoProps.register({ id, url, handles: { door: { node: 'Door', action: 'toggle' } } });
//   const h = await PoProps.mount('crate', scene, { position: [2,0,-3], theme: 'fortress' });
//   h.handle('door')?.play();
//
// Themes are material *recipes* (color/roughness/metalness/emissive) applied by
// material slot name at mount time — the mesh files stay untouched, which is
// exactly what lets a Vibe3D kit share a skin with our own props.
//
// Vibe3D kits themselves drop in via their CLI (`bunx vibe3d add …`) into
// wwwroot/js/props/; their sources export model + material modules that
// register here on import. No kit is bundled by default.
(function () {
    'use strict';

    const _props = new Map();    // id -> definition
    const _themes = new Map();   // theme name -> { slotName: recipe }
    const _cache = new Map();    // url -> loaded gltf scene (clone per mount)

    // Built-in themes. Deliberately few; games add their own via theme().
    _themes.set('steel', {
        default: { color: 0x8f9bab, roughness: 0.42, metalness: 0.85 },
        accent: { color: 0x22d3ee, roughness: 0.3, metalness: 0.6, emissive: 0x22d3ee, emissiveIntensity: 0.25 },
    });
    _themes.set('fortress', {
        default: { color: 0x8a8f98, roughness: 0.85, metalness: 0.15 },
        stone: { color: 0x7b7f88, roughness: 0.95, metalness: 0.05 },
        trim: { color: 0xfb923c, roughness: 0.5, metalness: 0.4 },
    });

    function register(def) {
        if (!def?.id || !def?.url) throw new Error('propRegistry.register: id and url are required');
        _props.set(def.id, def);
    }

    function theme(name, recipe) {
        if (recipe) _themes.set(name, recipe);
        return _themes.get(name) || null;
    }

    // Apply a theme to a cloned scene: a mesh joins the theme if its material
    // slot name (or mesh name) matches a recipe key, else gets `default`.
    function applyTheme(root, themeName) {
        const t = _themes.get(themeName);
        if (!t) return;
        root.traverse(function (node) {
            if (!node.isMesh) return;
            const slot = (Array.isArray(node.material) ? node.material.map(m => m.name) : [node.material?.name])
                .concat([node.name]).filter(Boolean);
            const recipeKey = slot.find(s => t[s]) ? slot.find(s => t[s]) : 'default';
            const r = t[recipeKey] || t.default;
            if (!r) return;
            node.material = new THREE.MeshStandardMaterial({
                color: r.color ?? 0x999999,
                roughness: r.roughness ?? 0.8,
                metalness: r.metalness ?? 0.1,
                emissive: r.emissive ?? 0x000000,
                emissiveIntensity: r.emissiveIntensity ?? 1,
            });
        });
    }

    async function mount(id, scene, opts) {
        const o = opts || {};
        const def = _props.get(id);
        if (!def) throw new Error('propRegistry: unknown prop "' + id + '"');

        let gltf = _cache.get(def.url);
        const THREE = o.THREE || window.THREE;
        if (!THREE?.GLTFLoader) throw new Error('propRegistry: THREE/GLTFLoader unavailable');
        if (!gltf) {
            const loader = new THREE.GLTFLoader();
            gltf = await loader.loadAsync(def.url);
            _cache.set(def.url, gltf);
        }

        const instance = gltf.scene.clone(true);
        applyTheme(instance, o.theme || def.theme);

        if (o.position) instance.position.fromArray(o.position);
        if (o.rotation) instance.rotation.set(o.rotation[0] || 0, o.rotation[1] || 0, o.rotation[2] || 0);
        if (o.scale) instance.scale.fromArray(typeof o.scale === 'number' ? [o.scale, o.scale, o.scale] : o.scale);
        scene.add(instance);

        // Runtime handles: named nodes exposed with a tiny play() contract so
        // game code never reaches into the model's innards.
        const handle = { root: instance, nodes: {}, dispose() { scene.remove(instance); } };
        for (const [name, h] of Object.entries(def.handles || {})) {
            const node = instance.getObjectByName(h.node);
            if (!node) continue;
            handle.nodes[name] = {
                node: node,
                play: function () {
                    if (h.action === 'spin') h.spin = !h.spin;
                    else if (h.action === 'toggle' && node.material) {
                        node.material.emissiveIntensity = node.material.emissiveIntensity > 0 ? 0 : 1;
                    }
                }
            };
        }
        // Spin handles tick in the game's loop via handle.update(dt).
        handle.update = function (dt) {
            for (const n of Object.values(handle.nodes)) {
                if (n.node && n._spinning !== false && def.handles) {
                    const def2 = Object.values(def.handles).find(d => d.node === n.node.name);
                    if (def2?.action === 'spin') n.node.rotation.y += dt * (def2.speed || 1);
                }
            }
        };
        return handle;
    }

    // THREE is injected by the first mount (games own their three import map).
    // Keep a module-level capture so later mounts do not need it re-passed.
    let _THREE = null;
    const _origMount = mount;
    const mountWithThree = function (id, scene, opts) {
        _THREE = (opts && opts.THREE) || _THREE || window.THREE;
        if (_THREE && !window.THREE) window.THREE = _THREE;
        return _origMount(id, scene, opts);
    };

    window.PoProps = {
        register: register,
        theme: theme,
        mount: mountWithThree,
        props: function () { return [..._props.keys()]; },
        themes: function () { return [..._themes.keys()]; }
    };
})();
