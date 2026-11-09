// ==UserScript==
// @name         Wordle Solver (NYT + Wordle Unlimited)
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Wordle solver for NYT Wordle and Wordle Unlimited
// @author       executed007
// @match        https://www.nytimes.com/games/wordle/*
// @match        https://wordleunlimited.org/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ── Config ─────────────────────────────────────────────────────────────
    const WORD_LIST_URL = 'https://raw.githubusercontent.com/seanpatlan/wordle-words/main/word-bank.csv';
    const CACHE_KEY = 'ws_words_v1';
    const CACHE_TTL_MS = 7 * 864e5;
    const POLL_MS = 400;
    const COOLDOWN_MS = 2200;
    const LOCK_MS = 1000;
    const ENTER_DELAY_MS = 300;
    const RETRY_MS = 10000;
    const NEXT_GAME_DELAY_MS = 2500;
    const WIN_CODE = 242; // all five tiles "correct" (2 * (1+3+9+27+81))
    const POW3 = [1, 3, 9, 27, 81];

    const isNYT = location.hostname.includes('nytimes.com');

    // Real images for the button. Put wordle.png and troll.png in an `assets`
    // folder in your repo; they're fetched once and cached. If either is missing,
    // the built-in SVG below is used instead.
    const ASSET_BASE = 'https://raw.githubusercontent.com/executed007/wordle-autosolver/main/assets/';
    const LOGO_FILE = 'wordle.png';
    const TROLL_FILE = 'troll.png';

    // Fallback button icon: 'pirate' (hat on top) or 'x' (big red X over it)
    const ICON = 'pirate';
    const TILE = '<rect x="6" y="16" width="52" height="46" rx="10" fill="#6aaa64"/>' +
        '<path d="M17 30l7 22 8-14 8 14 7-22" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>';
    const ICONS = {
        pirate: '<svg viewBox="0 0 64 64">' + TILE +
            '<g transform="rotate(-9 32 12)">' +
            '<path d="M5 24Q8 5 32 3Q56 5 59 24Q46 16 32 16Q18 16 5 24Z" fill="#1a1a1b" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/>' +
            '<circle cx="32" cy="10.5" r="4.6" fill="#fff"/><rect x="29.4" y="13" width="5.2" height="3.4" rx="1" fill="#fff"/>' +
            '<circle cx="30.2" cy="10.2" r="1.2" fill="#1a1a1b"/><circle cx="33.8" cy="10.2" r="1.2" fill="#1a1a1b"/></g></svg>',
        x: '<svg viewBox="0 0 64 64">' + TILE +
            '<path d="M14 18L50 60M50 18L14 60" stroke="#000" stroke-opacity=".35" stroke-width="12" stroke-linecap="round"/>' +
            '<path d="M14 18L50 60M50 18L14 60" stroke="#e5484d" stroke-width="8" stroke-linecap="round"/></svg>',
    };

    // ── State ──────────────────────────────────────────────────────────────
    let words = [];
    let cand = [];
    let applied = [];
    let lastSig = null;
    let state = 'play';     // 'play' | 'won' | 'over'
    let best = null;
    let auto = false;
    let keep = GM_getValue('ws_keep', true);   // keep auto-solve on across games / reloads
    let open = false;
    let timer = null;
    let submitting = false;
    let lastSubmit = 0, lastWord = '', lastWordTime = 0, lastNext = 0;
    let statusTimer = null;
    let shownBest = null;
    let $btn, $panel, $tiles, $count, $submit, $auto, $keep, $status, $dot;

    // ── Wordle feedback as a base-3 integer (0 absent, 1 present, 2 correct)
    const cnt = new Uint8Array(26);
    const out = new Uint8Array(5);

    function pattern(g, a) {
        cnt.fill(0);
        for (let i = 0; i < 5; i++) {
            const gc = g.charCodeAt(i), ac = a.charCodeAt(i);
            if (gc === ac) out[i] = 2;
            else { out[i] = 0; cnt[ac - 97]++; }
        }
        let code = 0;
        for (let i = 0; i < 5; i++) {
            let v = out[i];
            if (!v) {
                const c = g.charCodeAt(i) - 97;
                if (cnt[c]) { cnt[c]--; v = 1; }
            }
            code += v * POW3[i];
        }
        return code;
    }

    const enc = s => (s === 'correct' ? 2 : s === 'present' ? 1 : 0);

    // ── Board reading ──────────────────────────────────────────────────────
    function readNYT() {
        const t = document.querySelectorAll('[class*="Tile-module_tile"]');
        const res = [];
        for (let r = 0; r < 6 && r * 5 + 5 <= t.length; r++) {
            let word = '', code = 0;
            for (let i = 0; i < 5; i++) {
                const el = t[r * 5 + i];
                const l = el.textContent.trim().toLowerCase();
                const s = el.getAttribute('data-state');
                if (l.length !== 1 || !s || s === 'empty' || s === 'tbd') return res;
                word += l;
                code += enc(s) * POW3[i];
            }
            res.push({ word, code });
        }
        return res;
    }

    function readUnlimited() {
        const root = document.querySelector('game-app')?.shadowRoot;
        const rows = root?.getElementById('board')?.querySelectorAll('game-row');
        const res = [];
        if (!rows) return res;
        for (const row of rows) {
            const word = (row.getAttribute('letters') || '').toLowerCase();
            const tiles = row.shadowRoot?.querySelectorAll('game-tile');
            if (word.length !== 5 || !tiles || tiles.length !== 5) continue;
            let code = 0, ready = true;
            for (let i = 0; i < 5; i++) {
                const e = tiles[i].getAttribute('evaluation');
                if (!e || e === 'empty') { ready = false; break; }
                code += enc(e) * POW3[i];
            }
            if (ready) res.push({ word, code });
        }
        return res;
    }

    const readBoard = isNYT ? readNYT : readUnlimited;

    // ── Solver ─────────────────────────────────────────────────────────────
    function solve(g) {
        const keys = g.map(x => x.word + x.code);

        let start = applied.length;
        if (start > keys.length || applied.some((k, i) => k !== keys[i])) {
            cand = words;
            start = 0;
        }
        for (let i = start; i < g.length; i++) {
            const { word, code } = g[i];
            cand = cand.filter(w => pattern(word, w) === code);
        }
        applied = keys;

        if (g.some(x => x.code === WIN_CODE)) { state = 'won'; best = null; return; }
        if (g.length >= 6) { state = 'over'; best = null; return; }
        state = 'play';
        best = null;
        if (!cand.length) return;

        const freq = new Uint32Array(26);
        for (const w of cand) {
            let m = 0;
            for (let i = 0; i < 5; i++) {
                const c = w.charCodeAt(i) - 97, b = 1 << c;
                if (!(m & b)) { m |= b; freq[c]++; }
            }
        }
        let top = -1;
        for (const w of cand) {
            let m = 0, s = 0;
            for (let i = 0; i < 5; i++) {
                const c = w.charCodeAt(i) - 97, b = 1 << c;
                if (!(m & b)) { m |= b; s += freq[c]; }
            }
            if (s > top) { top = s; best = w; }
        }
    }

    // ── Submission ─────────────────────────────────────────────────────────
    function keyMap() {
        const m = new Map();
        const add = (b, k) => {
            k = (k || '').trim().toLowerCase();
            if (k === '↵') k = 'enter';
            if (k && !m.has(k)) m.set(k, b);
        };
        const roots = [document];
        const kb = document.querySelector('game-app')?.shadowRoot
            ?.querySelector('game-keyboard')?.shadowRoot;
        if (kb) roots.push(kb);

        for (const r of roots) {
            r.querySelectorAll('[data-key]').forEach(b => add(b, b.getAttribute('data-key')));
        }
        if (!m.has('enter')) {
            for (const r of roots) {
                r.querySelectorAll('button,[role="button"]').forEach(b =>
                    add(b, b.getAttribute('aria-label') || b.textContent));
            }
        }
        return m;
    }

    function submitWord(word) {
        const keys = [...word, 'enter'];
        const map = keyMap();

        if (keys.every(k => map.has(k))) {
            keys.forEach((k, i) => setTimeout(() => map.get(k).click(), i * 70));
            return;
        }
        const press = (key, code, keyCode) => document.dispatchEvent(new KeyboardEvent('keydown', {
            key, code, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true,
        }));
        for (const ch of word) press(ch, 'Key' + ch.toUpperCase(), ch.toUpperCase().charCodeAt(0));
        setTimeout(() => press('Enter', 'Enter', 13), ENTER_DELAY_MS);
    }

    function autoSubmit() {
        if (state !== 'play' || !best || submitting) return;
        const now = Date.now();
        if (now - lastSubmit < COOLDOWN_MS) return;
        if (best === lastWord && now - lastWordTime < RETRY_MS) return;

        submitting = true;
        lastSubmit = lastWordTime = now;
        lastWord = best;
        setStatus('Auto-submitting ' + best.toUpperCase());
        submitWord(best);
        setTimeout(() => { submitting = false; }, LOCK_MS);
    }

    // Best effort (Wordle Unlimited only): after a finished game, click a
    // "new game / play again" style button so auto-solve can continue.
    const NEXT_RE = /^(new game|play again|next( word| game)?|restart|continue)$/i;

    function findNextButton(root, depth = 0) {
        if (depth > 4) return null;
        for (const el of root.querySelectorAll('*')) {
            if ((el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') &&
                NEXT_RE.test((el.textContent || el.getAttribute('aria-label') || '').trim())) {
                return el;
            }
            if (el.shadowRoot) {
                const f = findNextButton(el.shadowRoot, depth + 1);
                if (f) return f;
            }
        }
        return null;
    }

    function startNextGame() {
        const now = Date.now();
        if (now - lastNext < NEXT_GAME_DELAY_MS) return;
        lastNext = now;
        const b = findNextButton(document);
        if (b) { b.click(); setStatus('Starting next game…'); }
    }

    // ── Refresh ────────────────────────────────────────────────────────────
    function render() {
        const ok = state === 'play' && best;

        const show = best || '';
        if (show !== shownBest) {
            shownBest = show;
            $tiles.innerHTML = (show || '     ').split('').map(c => `<i>${c.trim()}</i>`).join('');
        }
        const txt = state === 'won' ? '🎉 Solved!' : state === 'over' ? 'Game over' : cand.length.toLocaleString();
        if ($count.textContent !== txt) $count.textContent = txt;
        $submit.classList.toggle('off', !ok);
        $panel.dataset.state = state;
    }

    function refresh() {
        if (!words.length || document.hidden) return;
        const g = readBoard();
        const sig = g.map(x => x.word + x.code).join();
        if (sig !== lastSig) {
            lastSig = sig;
            solve(g);
            render();
        }
        if (!auto) return;
        if (state === 'play') autoSubmit();
        else if (keep && !isNYT) startNextGame();
    }

    function updatePolling() {
        const need = open || auto;
        if (need && !timer) timer = setInterval(refresh, POLL_MS);
        else if (!need && timer) { clearInterval(timer); timer = null; }
    }

    // ── UI ─────────────────────────────────────────────────────────────────
    function setStatus(msg) {
        if (!$status) return;
        $status.textContent = msg;
        clearTimeout(statusTimer);
        statusTimer = setTimeout(() => { $status.textContent = ''; }, 3000);
    }

    function setAuto(on) {
        auto = on;
        $auto.classList.toggle('on', on);
        $auto.setAttribute('aria-checked', on);
        $btn.classList.toggle('on', on);
        $dot.classList.toggle('on', on);
        GM_setValue('ws_auto', on && keep);
        updatePolling();
    }

    function setKeep(on) {
        keep = on;
        $keep.classList.toggle('on', on);
        $keep.setAttribute('aria-checked', on);
        GM_setValue('ws_keep', on);
        GM_setValue('ws_auto', auto && on);
    }

    function setOpen(on) {
        open = on;
        $panel.classList.toggle('show', on);
        updatePolling();
        if (on) refresh();
    }

    function buildUI() {
        if (document.getElementById('ws-toggle-btn')) return;

        const style = document.createElement('style');
        style.textContent = `
#ws-toggle-btn,#ws-panel,#ws-panel *{box-sizing:border-box}
#ws-toggle-btn{position:fixed;bottom:20px;right:20px;z-index:2147483647;width:58px;height:58px;border:0;background:none;cursor:pointer;padding:0;line-height:1;filter:drop-shadow(0 4px 8px rgba(0,0,0,.45));transition:transform .15s,filter .2s}
#ws-toggle-btn svg{width:100%;height:100%;display:block;overflow:visible}
#ws-toggle-btn img{display:block;-webkit-user-drag:none;user-select:none}
#ws-toggle-btn .lg{width:100%;height:100%;object-fit:contain;border-radius:12px}
#ws-toggle-btn .tr{position:absolute;right:-12px;bottom:-10px;width:36px;height:auto;transform:rotate(8deg);filter:drop-shadow(0 2px 3px rgba(0,0,0,.5))}
#ws-toggle-btn:hover{transform:scale(1.08) rotate(-4deg)}
#ws-toggle-btn.on{filter:drop-shadow(0 0 5px #c9b458) drop-shadow(0 0 12px rgba(201,180,88,.7))}
#ws-panel{position:fixed;bottom:92px;right:20px;z-index:2147483646;width:312px;background:rgba(24,24,26,.96);backdrop-filter:blur(10px);color:#f4f4f5;border-radius:18px;box-shadow:0 18px 50px rgba(0,0,0,.55);font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;overflow:hidden;border:1px solid rgba(255,255,255,.08);opacity:0;transform:translateY(10px) scale(.97);pointer-events:none;visibility:hidden;transition:opacity .18s,transform .18s,visibility .18s}
#ws-panel.show{opacity:1;transform:none;pointer-events:auto;visibility:visible}
#ws-panel .hd{display:flex;align-items:center;gap:10px;padding:14px 16px;background:linear-gradient(135deg,rgba(106,170,100,.22),rgba(201,180,88,.1));border-bottom:1px solid rgba(255,255,255,.07)}
#ws-panel .hd b{flex:1;font-size:14px;letter-spacing:.4px}
#ws-dot{width:9px;height:9px;border-radius:50%;background:#555;transition:background .2s,box-shadow .2s}
#ws-dot.on{background:#6aaa64;box-shadow:0 0 8px #6aaa64}
#ws-close{background:transparent;border:0;color:#999;font-size:20px;cursor:pointer;width:26px;height:26px;border-radius:8px;line-height:1;padding:0}
#ws-close:hover{background:rgba(255,255,255,.1);color:#fff}
#ws-panel .bd{padding:16px}
#ws-panel .lb{font-size:10.5px;text-transform:uppercase;letter-spacing:1.6px;color:#8b8b90;margin-bottom:8px}
#ws-tiles{display:flex;gap:6px;margin-bottom:14px}
#ws-tiles i{flex:1;aspect-ratio:1;display:flex;align-items:center;justify-content:center;border-radius:8px;background:#6aaa64;color:#fff;font:800 24px/1 monospace;font-style:normal;text-transform:uppercase;animation:wsPop .25s ease-out}
#ws-tiles i:empty{background:#2b2b2e;animation:none}
#ws-panel[data-state=won] #ws-tiles i{background:#c9b458}
@keyframes wsPop{from{transform:scale(.7);opacity:0}to{transform:none;opacity:1}}
#ws-panel .card{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:rgba(255,255,255,.05);border-radius:10px;margin-bottom:12px;font-size:13px}
#ws-panel .card span{color:#9a9aa0}
#ws-count{font-weight:700;color:#fff;font-size:15px}
#ws-panel .opt{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:9px 2px}
#ws-panel .opt+.opt{border-top:1px solid rgba(255,255,255,.06)}
#ws-panel .opt b{display:block;font-size:13px;font-weight:600}
#ws-panel .opt small{display:block;font-size:11px;color:#85858b;margin-top:1px}
#ws-panel .sw{flex:none;width:40px;height:22px;border-radius:11px;border:0;background:#3a3a3e;position:relative;cursor:pointer;padding:0;transition:background .18s}
#ws-panel .sw::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .18s}
#ws-panel .sw.on{background:#6aaa64}
#ws-panel .sw.on::after{transform:translateX(18px)}
#ws-submit{width:100%;margin-top:10px;padding:11px;background:linear-gradient(135deg,#6aaa64,#4d8a48);color:#fff;border:0;border-radius:10px;cursor:pointer;font-weight:700;font-size:12.5px;letter-spacing:1.2px;transition:filter .15s,transform .1s}
#ws-submit:hover{filter:brightness(1.1)}
#ws-submit:active{transform:scale(.98)}
#ws-submit.off{opacity:.35;pointer-events:none}
#ws-status{margin-top:10px;font-size:11px;color:#8b8b90;text-align:center;min-height:14px}`;
        document.head.appendChild(style);

        $btn = document.createElement('button');
        $btn.id = 'ws-toggle-btn';
        $btn.title = 'Wordle Solver';
        $btn.innerHTML = ICONS[ICON] || ICONS.pirate;
        $btn.onclick = () => setOpen(!open);

        $panel = document.createElement('div');
        $panel.id = 'ws-panel';
        $panel.dataset.state = 'play';
        $panel.innerHTML = `
<div class="hd"><span id="ws-dot"></span><b>Wordle Solver</b><button id="ws-close" title="Close">×</button></div>
<div class="bd">
<div class="lb">Best guess</div>
<div id="ws-tiles"><i></i><i></i><i></i><i></i><i></i></div>
<div class="card"><span>Possibilities remaining</span><div id="ws-count">—</div></div>
<div class="opt"><div><b>Auto-solve</b><small>Types &amp; submits guesses for you</small></div><button class="sw" id="ws-auto" role="switch" aria-checked="false"></button></div>
<div class="opt"><div><b>Stay on after solving</b><small>Keeps auto-solve running between games${isNYT ? '' : ' &amp; reloads'}</small></div><button class="sw" id="ws-keep" role="switch" aria-checked="false"></button></div>
<button id="ws-submit" class="off">SUBMIT BEST GUESS</button>
<div id="ws-status"></div>
</div>`;

        document.body.append($btn, $panel);

        const q = id => $panel.querySelector(id);
        $tiles = q('#ws-tiles');
        $count = q('#ws-count');
        $submit = q('#ws-submit');
        $auto = q('#ws-auto');
        $keep = q('#ws-keep');
        $status = q('#ws-status');
        $dot = q('#ws-dot');

        q('#ws-close').onclick = () => {
            setOpen(false);
            if (!keep) setAuto(false);      // with "stay on", closing only hides the panel
        };
        $auto.onclick = () => {
            setAuto(!auto);
            setStatus(auto ? 'Auto-solve enabled' : 'Auto-solve disabled');
            if (auto) refresh();
        };
        $keep.onclick = () => {
            setKeep(!keep);
            setStatus(keep ? 'Auto-solve will stay on' : 'Auto-solve will stop when closed');
        };
        $submit.onclick = () => {
            if (state === 'play' && best) {
                submitWord(best);
                setStatus('Submitted ' + best.toUpperCase());
            }
        };

        setKeep(keep);
        setAuto(keep && GM_getValue('ws_auto', false));   // restore after a reload
    }

    // ── Button images (fetched once, cached as data URIs) ──────────────────
    function fetchImage(name) {
        const key = 'ws_img_' + name;
        const cached = GM_getValue(key);
        if (cached) return Promise.resolve(cached);
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: ASSET_BASE + name,
                responseType: 'blob',
                onload: r => {
                    if (r.status !== 200 || !r.response) return resolve(null);
                    const fr = new FileReader();
                    fr.onload = () => { GM_setValue(key, fr.result); resolve(fr.result); };
                    fr.onerror = () => resolve(null);
                    fr.readAsDataURL(r.response);
                },
                onerror: () => resolve(null),
            });
        });
    }

    function applyImages() {
        Promise.all([fetchImage(LOGO_FILE), fetchImage(TROLL_FILE)]).then(([logo, troll]) => {
            if (!logo && !troll) return;   // keep the SVG fallback
            $btn.innerHTML =
                (logo ? `<img class="lg" src="${logo}" alt="">` : ICONS[ICON] || ICONS.pirate) +
                (troll ? `<img class="tr" src="${troll}" alt="">` : '');
        });
    }

    // ── Word list (cached between page loads) ──────────────────────────────
    const parse = text => text.split('\n').map(w => w.trim().toLowerCase()).filter(w => /^[a-z]{5}$/.test(w));

    function loadWords() {
        const cache = GM_getValue(CACHE_KEY);
        if (cache && Date.now() - cache.t < CACHE_TTL_MS) {
            return Promise.resolve(cache.w.split(' '));
        }
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: WORD_LIST_URL,
                onload: r => {
                    if (r.status !== 200) return reject(new Error('HTTP ' + r.status));
                    const list = parse(r.responseText);
                    GM_setValue(CACHE_KEY, { t: Date.now(), w: list.join(' ') });
                    resolve(list);
                },
                onerror: reject,
            });
        }).catch(e => {
            if (cache) return cache.w.split(' ');
            throw e;
        });
    }

    // ── Init ───────────────────────────────────────────────────────────────
    function init() {
        buildUI();
        applyImages();
        loadWords().then(list => {
            words = cand = list;
            lastSig = null;
            if (open || auto) refresh();
        }).catch(e => {
            console.error('[Wordle Solver] Word list load failed:', e);
            setStatus('Failed to load word list');
        });
    }

    if (document.body) init();
    else document.addEventListener('DOMContentLoaded', init);
})();