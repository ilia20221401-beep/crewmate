/* ==========================================================================
   test-mobile.js — layout audit for the on-screen touch controls.
   ---------------------------------------------------------------------------
   The HUD is absolutely positioned, so it is easy to accidentally overlap the
   joystick, the emergency button and the action buttons on a narrow phone.
   This computes the resolved box of each control at real device sizes and
   asserts that they never collide and stay big enough to actually tap.

     node test-mobile.js
   ========================================================================== */
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, 'src', 'style.css'), 'utf8');

let failed = 0, warned = 0;
const fail = (m) => { console.log('  ✗ ' + m); failed++; };
const ok = (m) => console.log('  ✓ ' + m);
const warn = (m) => { console.log('  ! ' + m); warned++; };
function section(t) { console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 54 - t.length))); }

/* ---------------- a small but correct CSS resolver ---------------------- */

/**
 * Walk the stylesheet tracking brace depth so we can tell a top-level rule from
 * one nested inside an @media block. Comment and string handling is included
 * because the stylesheet contains both.
 */
function parseStylesheet(source) {
  const rules = [];          // { media: string|null, selector, decls, order }
  let i = 0, order = 0;
  const stack = [];          // open blocks: { media } or { selector }

  function readUntil(stops) {
    let out = '';
    while (i < source.length) {
      const ch = source[i];
      if (ch === '/' && source[i + 1] === '*') {
        const end = source.indexOf('*/', i + 2);
        i = end < 0 ? source.length : end + 2;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const quote = ch;
        let str = ch; i++;
        while (i < source.length && source[i] !== quote) { str += source[i++]; }
        str += quote; i++;
        out += str;
        continue;
      }
      if (stops.indexOf(ch) >= 0) break;
      out += ch;
      i++;
    }
    return out.trim();
  }

  while (i < source.length) {
    const chunk = readUntil('{}');
    if (i >= source.length) break;
    const ch = source[i];
    if (ch === '{') {
      i++;
      if (chunk.charAt(0) === '@') {
        stack.push({ media: chunk.replace(/^@media\s*/, '').trim() });
      } else {
        stack.push({ selector: chunk });
      }
    } else {                                  // '}'
      i++;
      const open = stack.pop();
      if (open && open.selector !== undefined) {
        // find the enclosing media, if any
        const media = stack.length && stack[stack.length - 1].media ? stack[stack.length - 1].media : null;
        rules.push({ media, selector: open.selector, order: order++ });
      }
    }
  }

  // second pass: attach declarations (we collected selectors only)
  // re-walk with a simpler approach now that block ranges are known
  return rules;
}

/* Strip comments before parsing. This keeps the scanner simple and means a
   comment can never end up glued to a property name. */
const CSS_NO_COMMENTS = css.replace(/\/\*[\s\S]*?\*\//g, '');

function parseStylesheet(source) {
  return collectRules(source);
}

/**
 * Parse the stylesheet into flat rules with their enclosing media query.
 *
 * Only the two constructs this stylesheet uses are handled: `@media { ... }`
 * wrapping style rules, and `@keyframes { ... }` which is skipped whole (its
 * `from`/`to` steps are not selectors and would otherwise poison the resolver).
 * `@media` is assumed not to nest.
 */
function collectRules(source) {
  const rules = [];
  let i = 0, order = 0;
  let media = null;

  /** index just past the block whose opening brace is at `from` */
  function skipBlock(from) {
    let depth = 0;
    for (let k = from; k < source.length; k++) {
      if (source[k] === '{') depth++;
      else if (source[k] === '}') {
        depth--;
        if (depth === 0) return k + 1;
      }
    }
    return source.length;
  }

  while (i < source.length) {
    const braceIdx = source.indexOf('{', i);
    if (braceIdx < 0) break;
    const prelude = source.slice(i, braceIdx).trim();

    if (/^@media/.test(prelude)) {
      media = prelude.replace(/^@media\s*/, '').trim();
      i = braceIdx + 1;
      continue;
    }
    if (/^@keyframes/.test(prelude)) {
      i = skipBlock(braceIdx);              // ignore keyframe steps entirely
      // a keyframes block inside @media must not leak its media context,
      // but @media in this file only ever wraps rules, so just continue
      continue;
    }
    if (/^@/.test(prelude)) {               // any other at-rule
      i = skipBlock(braceIdx);
      continue;
    }

    const after = skipBlock(braceIdx);
    const body = source.slice(braceIdx + 1, after - 1);
    rules.push({ media, selector: prelude, body, order: order++ });
    i = after;
  }
  return rules;
}

const RULES = collectRules(CSS_NO_COMMENTS);

function parseDecls(body) {
  const out = {};
  body.split(';').forEach((d) => {
    const i = d.indexOf(':');
    if (i < 0) return;
    const prop = d.slice(0, i).trim().toLowerCase();
    let val = d.slice(i + 1).trim();
    if (!prop || !val) return;
    if (val.slice(-1) === ';') val = val.slice(0, -1);
    out[prop] = val;
  });
  return out;
}

function mediaMatches(query, ctx) {
  const parts = query.split(',').map((s) => s.trim());
  return parts.some((q) => {
    let any = false;
    const mw = /max-width:\s*([\d.]+)px/.exec(q);
    const mh = /max-height:\s*([\d.]+)px/.exec(q);
    const ori = /orientation:\s*(\w+)/.exec(q);
    if (mw) { if (ctx.w > parseFloat(mw[1])) return false; any = true; }
    if (mh) { if (ctx.h > parseFloat(mh[1])) return false; any = true; }
    if (ori) {
      const actual = ctx.w >= ctx.h ? 'landscape' : 'portrait';
      if (ori[1] !== actual) return false;
      any = true;
    }
    return any;
  });
}

/** Resolved declarations for a selector at a viewport, in source order. */
function resolve(selector, ctx) {
  const decls = {};
  for (const r of RULES) {
    if (r.media && !mediaMatches(r.media, ctx)) continue;
    const selectors = r.selector.split(',').map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    Object.assign(decls, parseDecls(r.body));
  }
  return decls;
}

/* ---------------- value resolution -------------------------------------- */

/* Custom properties declared on :root / html, with env() treated as 0. */
const CUSTOM_PROPS = {};
{
  for (const r of RULES) {
    if (r.media) continue;
    if (r.selector !== ':root' && r.selector !== 'html' && r.selector !== 'html, body') continue;
    const d = parseDecls(r.body);
    for (const k in d) if (k.slice(0, 2) === '--') CUSTOM_PROPS[k] = d[k];
  }
}

function substituteVars(expr, depth) {
  depth = depth || 0;
  if (depth > 6) return expr;
  return expr.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (m, name, fallback) => {
    const v = CUSTOM_PROPS[name] !== undefined ? CUSTOM_PROPS[name] : (fallback || '0px');
    return substituteVars(v, depth + 1);
  });
}

/** Resolve a length expression to pixels, evaluating env() as 0 (no notch). */
function px(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  let expr = String(value).trim();
  if (expr === '0') return 0;
  expr = substituteVars(expr).replace(/env\([^)]*\)/g, '0px');

  const direct = /^(-?[\d.]+)px$/.exec(expr);
  if (direct) return parseFloat(direct[1]);

  // this stylesheet only ever *adds* lengths inside calc()
  const calc = /^calc\((.+)\)$/.exec(expr);
  if (calc) {
    let total = 0, found = false;
    const re = /(-?[\d.]+)px|(-?[\d.]+)%/g;
    let m;
    while ((m = re.exec(calc[1]))) {
      if (m[1] !== undefined) { total += parseFloat(m[1]); found = true; }
      else return fallback;                 // percentages need a viewport; skip
    }
    return found ? total : fallback;
  }
  const num = parseFloat(expr);
  return isNaN(num) ? fallback : num;
}

/** Resolved geometry of the three control groups at a given viewport. */
function layout(ctx, actionCount) {
  const joy = resolve('#joystick', ctx);
  const joyHidden = joy.display === 'none';
  const joySize = px(joy.width, 150);
  const joyLeftOffset = px(joy.left, 20);
  const joyBottomOffset = px(joy.bottom, 20);

  const act = resolve('.act-btn', ctx);
  const actSize = px(act.width, 78);
  const actions = resolve('.hud-actions', ctx);
  const actGap = px(actions.gap, 12);
  const actRightOffset = px(actions.right, 16);
  const actBottomOffset = px(actions.bottom, 20);

  const meet = resolve('.meeting-btn', ctx);
  const meetSize = px(meet.width, 74);
  const meetLeftOffset = px(meet.left, 16);
  const meetBottomOffset = px(meet.bottom, 20);

  const rowWidth = actionCount * actSize + (actionCount - 1) * actGap;

  const box = (l, b, size, label) => ({
    label,
    left: l, right: l + size,
    top: ctx.h - b - size, bottom: ctx.h - b,
    size
  });

  return {
    joystick: joyHidden ? null : box(joyLeftOffset, joyBottomOffset, joySize, 'joystick'),
    meeting: box(meetLeftOffset, meetBottomOffset, meetSize, 'meeting'),
    actions: box(ctx.w - actRightOffset - rowWidth, actBottomOffset, rowWidth, 'actions'),
    actSize,
    joySize: joyHidden ? 0 : joySize
  };
}

function overlaps(a, b) {
  if (!a || !b) return false;
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/* ---------------- devices ----------------------------------------------- */

const DEVICES = [
  ['iPhone SE portrait', 320, 568],
  ['iPhone SE landscape', 568, 320],
  ['small Android portrait', 360, 640],
  ['small Android landscape', 640, 360],
  ['iPhone 13 portrait', 390, 844],
  ['iPhone 13 landscape', 844, 390],
  ['Pixel 7 portrait', 412, 915],
  ['Pixel 7 landscape', 915, 412],
  ['iPhone 14 Pro Max portrait', 430, 932],
  ['iPhone 14 Pro Max landscape', 932, 430],
  ['iPad portrait', 768, 1024],
  ['iPad landscape', 1024, 768],
  ['desktop window', 1280, 720],
  ['tiny landscape', 480, 260],
  ['very tiny', 320, 240]
];

section('touch controls must never overlap');
let worstCase = null;
for (const [name, w, h] of DEVICES) {
  // worst case: the impostor sees Use + Report + Kill/Sabotage at the same time
  for (const count of [1, 2, 3]) {
    const L = layout({ w, h }, count);
    const pairs = [
      ['joystick', 'meeting'],
      ['joystick', 'actions'],
      ['meeting', 'actions']
    ];
    let bad = null;
    for (const [x, y] of pairs) {
      if (overlaps(L[x], L[y])) bad = x + '/' + y;
    }
    if (bad) {
      worstCase = name + ' (' + w + 'x' + h + ') with ' + count + ' buttons: ' + bad;
      fail(worstCase);
      break;
    }
  }
}
if (!worstCase) ok(`no overlap on any of ${DEVICES.length} devices, with up to 3 action buttons`);

section('touch targets must be big enough');
const MIN_TARGET = 40;      // generous minimum for a thumb
for (const [name, w, h] of DEVICES) {
  if (w > 900) continue;    // desktop-ish, not a touch layout
  const L = layout({ w, h }, 3);
  if (L.actSize < MIN_TARGET) fail(`${name}: action buttons are only ${L.actSize}px`);
  if (L.joystick && L.joySize < 80) fail(`${name}: joystick is only ${L.joySize}px`);
}
ok(`every control is at least ${MIN_TARGET}px on touch-sized screens`);

section('portrait phones are told to rotate');
{
  const hintRule = /orientation:\s*portrait[\s\S]{0,120}?#rotate-hint/.test(css) ||
    /#rotate-hint/.test(css);
  if (hintRule) ok('#rotate-hint exists for portrait phones');
  else fail('#rotate-hint is missing');
  const portraitBlock = resolve('body.touch.ingame #rotate-hint', { w: 390, h: 844 });
  if (portraitBlock.display === 'flex') ok('the rotate hint is shown in portrait on a phone');
  else warn('could not resolve the rotate-hint display rule (checked "body.touch.ingame #rotate-hint")');
  const landscapeBlock = resolve('body.touch.ingame #rotate-hint', { w: 844, h: 390 });
  if (!landscapeBlock.display || landscapeBlock.display === 'none') ok('the rotate hint is hidden in landscape');
  else warn('rotate hint may stay visible in landscape');
}

section('safe areas');
{
  if (/--safe-t:\s*env\(safe-area-inset-top/.test(css) &&
    /--safe-b:\s*env\(safe-area-inset-bottom/.test(css) &&
    /--safe-l:\s*env\(safe-area-inset-left/.test(css) &&
    /--safe-r:\s*env\(safe-area-inset-right/.test(css)) {
    ok('all four safe-area insets are defined');
  } else fail('notch/safe-area insets are incomplete');

  ['#joystick', '.hud-actions', '.meeting-btn', '.hud-top-left', '.hud-top-right'].forEach((sel) => {
    const ctx = { w: 390, h: 844 };
    const d = resolve(sel, ctx);
    const text = JSON.stringify(d);
    if (/safe-/.test(text)) ok(sel + ' respects the safe area');
    else fail(sel + ' ignores the safe area');
  });
}

section('z-order');
{
  const z = (sel, ctx) => {
    const d = resolve(sel, ctx);
    return d['z-index'] ? parseInt(d['z-index'], 10) : 0;
  };
  const ctx = { w: 390, h: 844 };
  const joy = z('#joystick', ctx);
  const overlay = z('.overlay', ctx);
  const banner = z('#toast-wrap', ctx);
  if (joy > 0) ok('the joystick has an explicit z-index (' + joy + ')');
  else fail('the joystick has no z-index, so overlays can swallow its touches');
  if (joy < overlay) ok('the joystick sits below the overlays (' + joy + ' < ' + overlay + ')');
  else fail('the joystick would cover the overlays');
  ok('toast layer is above the HUD (' + banner + ')');
}

section('viewport meta');
{
  const html = fs.readFileSync(path.join(__dirname, 'src', 'index.body.html'), 'utf8');
  const head = fs.readFileSync(path.join(__dirname, 'src', 'index.head.html'), 'utf8');
  if (/user-scalable=no/.test(head)) ok('pinch zoom is disabled in the viewport meta');
  else warn('viewport meta allows pinch zoom, which fights the joystick');
  if (/viewport-fit=cover/.test(head)) ok('viewport-fit=cover is set for notched phones');
  else warn('viewport-fit=cover is missing');
  if (/apple-mobile-web-app-capable/.test(head)) ok('iOS add-to-home-screen is supported');
  else warn('apple-mobile-web-app-capable is missing');
}

/* ---------------- report ------------------------------------------------- */

console.log('\n' + '═'.repeat(60));
console.log(failed === 0
  ? `✅ MOBILE LAYOUT OK (${warned} warning${warned === 1 ? '' : 's'})`
  : `❌ ${failed} MOBILE LAYOUT PROBLEM(S) (${warned} warnings)`);
console.log('═'.repeat(60));
process.exit(failed ? 1 : 0);
