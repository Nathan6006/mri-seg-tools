/**
 * Accounts, workspaces, storage and the Files panel.
 *
 * Built in JavaScript rather than markup because the page's CSP forbids
 * inline script, and because this whole surface is conditional: someone
 * working offline against their own browser never needs to see any of it.
 *
 * THREE THINGS THAT SHAPE THIS FILE
 *
 * 1. The default is LOCAL. The tool has been in use with results in
 *    IndexedDB. Booting into a sign-in wall would leave those people staring
 *    at a login screen with their cohort apparently gone -- still on disk,
 *    unreachable, which is the same thing from where they sit. The page
 *    opens exactly as it did; signing in is a header button.
 *
 * 2. Not approved is a NORMAL state, not an error. Anyone may register. Only
 *    approved accounts open shared workspaces, because that storage is
 *    billed to one person. An unapproved visitor gets the full tool with
 *    local storage and a plain explanation, not a dead end.
 *
 * 3. The Files panel is navigable the way the worklist is. The reviewer this
 *    was built for singled out clicking between scans as what he liked, so
 *    the same gestures work here: arrow keys move, space selects, Enter
 *    opens, Delete removes. A panel you can only operate with a mouse would
 *    be a step down from the thing it sits next to.
 */

import * as Backend from './backend.js';

let UI = null;            // { user, workspaces, activeId }
let USAGE = null;
let ONSWITCH = () => {};

/* ------------------------------------------------------------------ fetch */

async function api(path, options = {}) {
  const r = await fetch(path, { credentials: 'same-origin', ...options });
  let body = null;
  try { body = await r.json(); } catch { /* some responses carry no body */ }
  if (!r.ok) {
    const err = new Error(body?.error || `${r.status} ${r.statusText}`);
    err.code = body?.code;
    err.status = r.status;
    err.usage = body?.usage;
    throw err;
  }
  return body;
}

const postJson = (path, data) => api(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data),
});

/* ----------------------------------------------------------------- format */

export function humanBytes(n) {
  if (n == null) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} kB`;
  return `${n} B`;
}

const ago = (ts) => {
  if (!ts) return '';
  const d = Math.floor((Date.now() - ts) / 1000);
  if (d < 90) return 'just now';
  if (d < 5400) return `${Math.round(d / 60)} min ago`;
  if (d < 172800) return `${Math.round(d / 3600)} h ago`;
  return `${Math.round(d / 86400)} d ago`;
};

/* --------------------------------------------------------------- elements */

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

let KEYHANDLER = null;

function closeSheet() {
  document.getElementById('acctOvl')?.remove();
  if (KEYHANDLER) { document.removeEventListener('keydown', KEYHANDLER, true); KEYHANDLER = null; }
}

/**
 * @param {string} title
 * @param {(body: HTMLElement, foot: HTMLElement) => void} build
 * @param {{wide?: boolean}} opts
 */
function sheet(title, build, { wide = false } = {}) {
  closeSheet();
  const body = el('div', { class: 'a-body' });
  const foot = el('div', { class: 'a-foot' });
  const card = el('div', { class: `a-sheet${wide ? ' a-wide' : ''}` },
    el('header', { class: 'row' },
      el('h2', {}, title),
      el('span', { class: 'spacer' }),
      el('button', { class: 'ghost', title: 'Close (Esc)', onclick: closeSheet }, '✕')),
    body, foot);
  const ovl = el('div', { id: 'acctOvl', class: 'a-ovl',
    onclick: (e) => { if (e.target === ovl) closeSheet(); } }, card);
  document.body.append(ovl);

  // Captured on the document, because the panel's own list takes focus and
  // Escape has to work from anywhere inside it.
  KEYHANDLER = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeSheet(); } };
  document.addEventListener('keydown', KEYHANDLER, true);

  build(body, foot);
  return { body, foot };
}

function errorInto(parent, message) {
  parent.querySelector('.a-err')?.remove();
  const box = el('div', { class: 'a-err' }, message);
  parent.prepend(box);
  box.scrollIntoView({ block: 'nearest' });
}

/* --------------------------------------------------------- storage meter */

function meter(u, { compact = false } = {}) {
  const pct = Math.min(100, (u.fraction || 0) * 100);
  return el('div', { class: 'a-meterwrap' },
    el('div', { class: `a-meter a-lv-${u.level}` }, el('div', { style: `width:${pct}%` })),
    el('div', { class: 'a-meterline' },
      el('span', {}, `${humanBytes(u.used)} of ${humanBytes(u.quota)} used`),
      el('span', {}, compact ? `${pct.toFixed(0)}%`
        : `${humanBytes(u.remaining)} free`)));
}

/**
 * The warning the whole quota system exists to deliver.
 *
 * It names the actual consequence at each level rather than saying "storage
 * is filling up". The reason the ceiling is 9 GB and not 10 is that nothing
 * should ever reach the card, and someone deciding whether to delete a
 * cohort deserves to know that is what the number is for.
 */
function quotaBanner(u) {
  if (!u || u.level === 'ok') return null;
  const msg = {
    warn: `Shared storage is ${(u.fraction * 100).toFixed(0)}% full `
        + `(${humanBytes(u.remaining)} left). Worth deleting scans you have `
        + `finished with — this panel sorts by size.`,
    critical: `Shared storage is ${(u.fraction * 100).toFixed(0)}% full — only `
        + `${humanBytes(u.remaining)} left. Uploads will start being refused. `
        + `Delete some scans now.`,
    full: `Shared storage is full. Uploads are being refused until something `
        + `is deleted. Nothing has been billed: the limit sits below the free `
        + `tier precisely so that it cannot be.`,
  }[u.level];
  return el('div', { class: `a-quotabar a-lv-${u.level}` }, msg);
}

async function refreshUsage() {
  try { USAGE = await api('/api/usage'); } catch { USAGE = null; }
  return USAGE;
}

/* ------------------------------------------------------------ sign in box */

function signInForm(mode = 'login') {
  sheet(mode === 'register' ? 'Create an account' : 'Sign in', (body, foot) => {
    const registering = mode === 'register';
    body.append(el('p', { class: 'a-hintline', style: 'margin:0 0 6px' },
      registering
        ? 'An account lets you open a shared workspace. Results stay in this '
        + 'browser until you open one.'
        : 'Signing in does not move anything on its own — you choose a '
        + 'workspace afterwards.'));

    const f = {};
    const field = (key, label, type, hint) => {
      body.append(el('label', {}, label));
      f[key] = el('input', { type, autocomplete: type === 'password'
        ? (registering ? 'new-password' : 'current-password') : 'username' });
      body.append(f[key]);
      if (hint) body.append(el('div', { class: 'a-hintline' }, hint));
    };
    if (registering) field('displayName', 'Your name', 'text');
    field('username', 'Username', 'text',
      registering ? '3–32 characters: letters, digits, dot, dash or underscore.' : null);
    field('password', 'Password', 'password',
      registering ? 'At least 8 characters. Length matters more than punctuation.' : null);

    const go = async () => {
      btn.disabled = true;
      btn.textContent = registering ? 'Creating…' : 'Signing in…';
      try {
        const payload = registering
          ? { username: f.username.value, password: f.password.value,
              displayName: f.displayName.value }
          : { username: f.username.value, password: f.password.value };
        const { user } = await postJson(
          registering ? '/api/auth/register' : '/api/auth/login', payload);
        UI = { user, workspaces: [], activeId: null };
        await loadWorkspaces();
        paintHeader();
        workspacePicker();
      } catch (e) {
        errorInto(body, e.message);
        btn.disabled = false;
        btn.textContent = registering ? 'Create account' : 'Sign in';
      }
    };

    const btn = el('button', { class: 'primary', onclick: go },
      registering ? 'Create account' : 'Sign in');
    for (const i of Object.values(f)) {
      i.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    }

    foot.append(
      el('button', { class: 'ghost', onclick: () => signInForm(registering ? 'login' : 'register') },
        registering ? 'I already have an account' : 'Create an account'),
      el('span', { class: 'spacer' }), btn);
    body.querySelector('input')?.focus();
  });
}

/* --------------------------------------------------------- workspace list */

async function loadWorkspaces() {
  if (!UI?.user?.approved) { UI.workspaces = []; return; }
  const { workspaces } = await api('/api/workspaces');
  UI.workspaces = workspaces;
  await refreshUsage();
}

/**
 * @param {boolean} revalidated - internal: set once usage has been re-read,
 *   so the repaint does not kick off another fetch and recurse forever.
 */
function workspacePicker(revalidated = false) {
  // Usage is re-read every time this opens rather than trusted from the last
  // page load. The warning banner is the entire reason the quota system
  // exists, and a banner driven by a cached figure is one that stays silent
  // through exactly the session where storage filled up.
  if (!revalidated && UI?.user?.approved) {
    refreshUsage().then(() => {
      // Only repaint if this sheet is still the one on screen -- the user
      // may have moved on during the round trip.
      const open = document.querySelector('.a-sheet h2');
      if (open && open.textContent === 'Workspaces') workspacePicker(true);
      paintHeader();
    }).catch(() => {});
  }
  sheet('Workspaces', (body, foot) => {
    body.append(el('p', { class: 'a-hintline', style: 'margin:0 0 12px' },
      `Signed in as ${UI.user.displayName} (${UI.user.username})`
      + (UI.user.isAdmin ? ' · administrator' : '')));

    // The honest dead-end, explained rather than hidden.
    if (!UI.user.approved) {
      body.append(el('div', { class: 'a-note' },
        el('div', { style: 'font-weight:600;margin-bottom:4px' },
          'This account is not approved for shared workspaces'),
        el('div', {},
          'Everything else works: scans you segment are stored in this '
          + 'browser, exactly as they were before accounts existed. Shared '
          + 'storage is limited and billed to the lab, so it is granted '
          + 'rather than claimed. Ask whoever runs this instance to approve '),
        el('div', { style: 'margin-top:6px' },
          el('code', {}, UI.user.username))));
      foot.append(el('button', { class: 'ghost', onclick: signOut }, 'Sign out'),
        el('span', { class: 'spacer' }),
        el('button', { class: 'primary', onclick: () => { closeSheet(); } }, 'Carry on locally'));
      return;
    }

    if (USAGE) {
      const b = quotaBanner(USAGE);
      if (b) body.append(b);
      body.append(el('div', { style: 'margin-bottom:16px' }, meter(USAGE)));
    }

    for (const w of UI.workspaces) {
      const active = UI.activeId === w.id;
      body.append(el('div', { class: 'a-urow' },
        el('div', { class: 'grow' },
          el('div', { style: 'font-weight:600' }, w.name,
            active ? el('span', { class: 'a-badge a-lv-ok', style: 'margin-left:6px' }, 'open') : null),
          el('div', { class: 'meta' },
            `${w.n_cases} scan(s) · ${w.n_members} member(s) · you are ${w.role}`)),
        el('div', { class: 'row' },
          el('button', { class: 'ghost', title: 'Scans and storage',
            onclick: () => filesPanel(w) }, 'Files'),
          w.role === 'owner'
            ? el('button', { class: 'ghost', onclick: () => manageMembers(w) }, 'Share')
            : null,
          el('button', { class: active ? '' : 'primary',
            onclick: () => openWorkspace(w) }, active ? 'Reopen' : 'Open'))));
    }

    const name = el('input', { placeholder: 'e.g. Cohort 2 review' });
    body.append(el('label', {}, 'Create another workspace'), name,
      el('button', { style: 'margin-top:8px', onclick: async () => {
        if (!name.value.trim()) return;
        try { await postJson('/api/workspaces', { name: name.value.trim() });
          await loadWorkspaces(); workspacePicker(); }
        catch (e) { errorInto(body, e.message); }
      } }, 'Create'));

    foot.append(
      el('button', { class: 'ghost', onclick: switchToLocal }, 'Use local storage'),
      UI.user.isAdmin
        ? el('button', { class: 'ghost', onclick: adminPanel }, 'Accounts')
        : null,
      el('span', { class: 'spacer' }),
      el('button', { class: 'ghost', onclick: signOut }, 'Sign out'));
  });
}

/* ============================================================ FILES PANEL */

/**
 * What is stored, how big it is, and how to get rid of it.
 *
 * Sorted by size descending by default, because the only reason to open this
 * while under pressure is to find what to delete, and the biggest thing is
 * the answer nine times in ten.
 */
function filesPanel(w) {
  sheet(`Files — ${w.name}`, async (body, foot) => {
    let items = [];
    let sortKey = 'size';
    const selected = new Set();
    let cursor = 0;

    const list = el('div', {});
    const head = el('div', {});
    body.append(head, list);

    const sortSel = el('select', { style: 'width:auto',
      onchange: () => { sortKey = sortSel.value; paint(); } },
      el('option', { value: 'size' }, 'Largest first'),
      el('option', { value: 'name' }, 'Name'),
      el('option', { value: 'date' }, 'Most recent'));

    const selectAll = el('button', { class: 'ghost', onclick: () => {
      if (selected.size === items.length) selected.clear();
      else for (const i of items) selected.add(i.case);
      paint();
    } }, 'Select all');

    const delBtn = el('button', { class: 'primary', onclick: doDelete });
    const foundLine = el('span', { class: 'meta' });

    foot.append(foundLine, el('span', { class: 'spacer' }), selectAll, delBtn);

    function sorted() {
      const c = [...items];
      if (sortKey === 'size') c.sort((a, b) => b.bytes - a.bytes);
      else if (sortKey === 'name') c.sort((a, b) => a.case.localeCompare(b.case));
      else c.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return c;
    }

    function paint() {
      const rows = sorted();
      const biggest = Math.max(1, ...rows.map((r) => r.bytes));

      head.replaceChildren();
      if (USAGE) {
        const b = quotaBanner(USAGE);
        if (b) head.append(b);
        head.append(el('div', { style: 'margin-bottom:14px' }, meter(USAGE)));
      }
      head.append(el('div', { class: 'a-ftools' },
        el('span', { class: 'meta' }, `${rows.length} scan(s) · `
          + `${humanBytes(rows.reduce((s, r) => s + r.bytes, 0))} in this workspace`),
        el('span', { class: 'spacer' }),
        el('span', { class: 'meta' }, 'Sort'), sortSel));

      list.replaceChildren();
      if (!rows.length) {
        list.append(el('p', { class: 'a-hintline' },
          'Nothing uploaded to this workspace yet.'));
      }
      rows.forEach((r, idx) => {
        const chips = el('span', {},
          ...r.files.map((f) => el('span', { class: 'a-chip' }, `${f.kind} ${humanBytes(f.bytes)}`)),
          ...r.layers.map((l) => el('span', { class: `a-chip${l.mine ? ' a-mine' : ''}` },
            `${l.mine ? 'your' : l.displayName.split(/\s+/)[0] + "'s"} mask`)));

        const row = el('div', {
          class: `a-frow${selected.has(r.case) ? ' a-sel' : ''}${idx === cursor ? ' a-cur' : ''}`,
          onclick: (e) => {
            cursor = idx;
            if (e.target.type !== 'checkbox') toggle(r.case);
            else paint();
          },
        },
          el('input', { type: 'checkbox', checked: selected.has(r.case),
            onchange: () => toggle(r.case) }),
          el('div', { class: 'grow' },
            el('div', { class: 'a-nm' }, r.case),
            el('div', { class: 'a-sub' }, chips),
            el('div', { class: 'a-sub' },
              `${r.addedBy || 'unknown'} · ${ago(r.updatedAt)}`)),
          el('div', { class: 'a-sizebar' },
            el('div', { style: `width:${(r.bytes / biggest) * 100}%` })),
          el('div', { class: 'a-szt' }, humanBytes(r.bytes)));
        list.append(row);
      });

      const freed = rows.filter((r) => selected.has(r.case))
        .reduce((s, r) => s + r.bytes, 0);
      selectAll.textContent = selected.size === rows.length && rows.length
        ? 'Select none' : 'Select all';
      delBtn.disabled = !selected.size;
      delBtn.textContent = selected.size
        ? `Delete ${selected.size} · frees ${humanBytes(freed)}` : 'Delete';
      foundLine.textContent = selected.size
        ? `${selected.size} selected`
        : '↑↓ move · space select · del delete';

      list.querySelector('.frow.cur')?.scrollIntoView({ block: 'nearest' });
    }

    function toggle(name) {
      if (selected.has(name)) selected.delete(name); else selected.add(name);
      paint();
    }

    // The same gestures the worklist uses. Someone who already navigates
    // scans with the arrow keys should not have to reach for the mouse here.
    const keys = (e) => {
      if (!document.getElementById('acctOvl')) return;
      const rows = sorted();
      if (e.key === 'ArrowDown') { cursor = Math.min(rows.length - 1, cursor + 1); paint(); }
      else if (e.key === 'ArrowUp') { cursor = Math.max(0, cursor - 1); paint(); }
      else if (e.key === ' ') { if (rows[cursor]) toggle(rows[cursor].case); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { if (selected.size) doDelete(); }
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener('keydown', keys, true);
    const stop = new MutationObserver(() => {
      if (!document.getElementById('acctOvl')) {
        document.removeEventListener('keydown', keys, true);
        stop.disconnect();
      }
    });
    stop.observe(document.body, { childList: true });

    async function doDelete() {
      const names = [...selected];
      if (!names.length) return;
      const freed = sorted().filter((r) => selected.has(r.case))
        .reduce((s, r) => s + r.bytes, 0);
      // Deletion removes everyone's layers, not just the caller's, so the
      // confirmation says whose work is going.
      const layers = sorted().filter((r) => selected.has(r.case))
        .reduce((s, r) => s + r.layers.length, 0);
      const ok = confirm(
        `Delete ${names.length} scan(s) from "${w.name}"?\n\n`
        + `This frees ${humanBytes(freed)} and removes ${layers} mask layer(s), `
        + `including any drawn by other people. It cannot be undone.`);
      if (!ok) return;

      delBtn.disabled = true; delBtn.textContent = 'Deleting…';
      try {
        const res = await postJson(`/api/w/${w.id}/delete-cases`, { names });
        USAGE = res.usage;
        selected.clear();
        await load();
        // The open worklist still shows the deleted scans otherwise.
        if (Backend.storageMode_() === Backend.STORAGE_CLOUD) await ONSWITCH();
      } catch (e) {
        errorInto(body, e.message);
        paint();
      }
    }

    async function load() {
      try {
        const d = await api(`/api/w/${w.id}/files`);
        items = d.items;
        USAGE = d.usage;
        cursor = Math.min(cursor, Math.max(0, items.length - 1));
        paint();
      } catch (e) { errorInto(body, e.message); }
    }

    list.append(el('p', { class: 'a-hintline' }, 'Loading…'));
    await load();
  }, { wide: true });
}

/* ------------------------------------------------------------ sharing */

function manageMembers(w) {
  sheet(`Share — ${w.name}`, async (body, foot) => {
    body.append(el('p', { class: 'a-hintline', style: 'margin:0 0 10px' },
      'People you add see every scan here and outline them in their own '
      + 'layer. Nobody can overwrite anyone else\'s mask.'));
    const list = el('div', {});
    body.append(list);

    const paint = async () => {
      const { members } = await api(`/api/w/${w.id}/members`);
      list.replaceChildren();
      for (const m of members) {
        list.append(el('div', { class: 'a-urow' },
          el('div', { class: 'grow' },
            el('div', { style: 'font-weight:600' }, m.display_name),
            el('div', { class: 'meta' }, `${m.username} · ${m.role}`)),
          m.role === 'owner'
            ? el('span', { class: 'a-badge a-adm' }, 'owner')
            : el('button', { class: 'ghost', onclick: async () => {
                try { await api(`/api/w/${w.id}/members/${m.id}`, { method: 'DELETE' }); await paint(); }
                catch (e) { errorInto(body, e.message); }
              } }, 'Remove')));
      }
    };
    await paint();

    const who = el('input', { placeholder: 'their username' });
    const role = el('select', {},
      el('option', { value: 'editor' }, 'Editor — can outline and review'),
      el('option', { value: 'viewer' }, 'Viewer — can look, not change'));
    body.append(el('label', {}, 'Add someone by username'), who,
      el('div', { style: 'height:8px' }), role,
      el('div', { class: 'a-hintline' },
        'They need an approved account first.'));

    foot.append(el('button', { class: 'ghost', onclick: () => workspacePicker() }, 'Back'),
      el('span', { class: 'spacer' }),
      el('button', { class: 'primary', onclick: async () => {
        try {
          await postJson(`/api/w/${w.id}/members`,
            { username: who.value.trim(), role: role.value });
          who.value = ''; await paint(); await loadWorkspaces();
        } catch (e) { errorInto(body, e.message); }
      } }, 'Add'));
  });
}

/* -------------------------------------------------------------- admin */

function adminPanel() {
  sheet('Accounts', async (body, foot) => {
    body.append(el('p', { class: 'a-hintline', style: 'margin:0 0 10px' },
      'Only approved accounts can open shared workspaces. Everyone else '
      + 'still gets the full tool with results stored in their own browser.'));

    const list = el('div', {});
    body.append(list);

    const paint = async () => {
      const { users } = await api('/api/admin/users');
      list.replaceChildren();
      for (const u of users) {
        list.append(el('div', { class: 'a-urow' },
          el('div', { class: 'grow' },
            el('div', { style: 'font-weight:600' }, u.display_name, ' ',
              u.is_admin ? el('span', { class: 'a-badge a-adm' }, 'admin') : null,
              el('span', { class: `a-badge ${u.approved ? 'a-lv-ok' : 'a-lv-no'}`,
                style: 'margin-left:4px' }, u.approved ? 'approved' : 'local only')),
            el('div', { class: 'meta' },
              `${u.username} · ${u.n_workspaces} workspace(s) · `
              + `${u.last_login_at ? 'last in ' + ago(u.last_login_at) : 'never signed in'}`)),
          el('div', { class: 'row' },
            el('button', {
              class: u.approved ? 'ghost' : 'primary',
              onclick: async () => {
                if (u.approved && !confirm(
                  `Remove ${u.display_name}'s access to shared workspaces?\n\n`
                  + 'Their masks stay in the workspace — this only stops them '
                  + 'opening it.')) return;
                try { await postJson(`/api/admin/users/${u.id}/approve`,
                  { approved: !u.approved }); await paint(); }
                catch (e) { errorInto(body, e.message); }
              },
            }, u.approved ? 'Revoke' : 'Approve'),
            u.approved ? el('button', { class: 'ghost', onclick: async () => {
              try { await postJson(`/api/admin/users/${u.id}/admin`,
                { isAdmin: !u.is_admin }); await paint(); }
              catch (e) { errorInto(body, e.message); }
            } }, u.is_admin ? 'Demote' : 'Make admin') : null)));
      }
    };
    await paint();

    // Storage ceiling, editable, with the reason it exists stated next to it.
    if (USAGE) {
      body.append(el('label', {}, 'Storage limit'),
        el('div', { class: 'a-hintline', style: 'margin-bottom:6px' },
          `Uploads are refused above this. It is deliberately under the `
          + `${humanBytes(USAGE.freeTierBytes)} free tier so that nothing `
          + `reaches a card. Currently ${humanBytes(USAGE.used)} in use.`));
      const gbIn = el('input', { type: 'number', step: '0.5', min: '0.5',
        value: (USAGE.quota / 1e9).toFixed(1), style: 'width:auto' });
      body.append(el('div', { class: 'row' }, gbIn, el('span', { class: 'meta' }, 'GB'),
        el('button', { onclick: async () => {
          try {
            await postJson('/api/admin/settings',
              { quota_bytes: Math.round(Number(gbIn.value) * 1e9) });
            await refreshUsage(); adminPanel();
          } catch (e) { errorInto(body, e.message); }
        } }, 'Save')));
    }

    foot.append(el('button', { class: 'ghost', onclick: () => workspacePicker() }, 'Back'),
      el('span', { class: 'spacer' }),
      el('button', { class: 'ghost', title: 'Compare the database against the bucket',
        onclick: async () => {
          try {
            const r = await postJson('/api/admin/reconcile', {});
            alert(r.agrees
              ? `Storage accounting agrees.\n\n${r.bucket.objects} object(s), `
                + `${humanBytes(r.bucket.bytes)}.`
              : `Storage accounting DISAGREES.\n\nBucket: ${humanBytes(r.bucket.bytes)} `
                + `in ${r.bucket.objects} object(s)\nDatabase: `
                + `${humanBytes(r.database.bytes)} in ${r.database.rows} row(s)\n`
                + `Drift: ${humanBytes(Math.abs(r.driftBytes))}`);
          } catch (e) { errorInto(body, e.message); }
        } }, 'Check storage'));
  }, { wide: true });
}

/* ------------------------------------------------------------- switching */

async function openWorkspace(w) {
  closeSheet();
  UI.activeId = w.id;
  await Backend.useStorage(Backend.STORAGE_CLOUD, { workspaceId: w.id, user: UI.user });
  await refreshUsage();
  paintHeader();
  await ONSWITCH();
}

async function switchToLocal() {
  closeSheet();
  if (UI) UI.activeId = null;
  await Backend.useStorage(Backend.STORAGE_LOCAL);
  paintHeader();
  await ONSWITCH();
}

async function signOut() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* going anyway */ }
  UI = null; USAGE = null;
  await switchToLocal();
}

/* ---------------------------------------------------------------- header */

function paintHeader() {
  const slot = document.getElementById('acctSlot');
  if (!slot) return;
  slot.replaceChildren();

  const active = UI?.activeId && UI.workspaces.find((w) => w.id === UI.activeId);

  if (active && USAGE) {
    // A small meter in the header, so the person filling the storage sees it
    // filling without having to go and look.
    slot.append(el('span', {
      class: 'row', style: 'gap:6px;min-width:150px;cursor:pointer',
      title: `${humanBytes(USAGE.used)} of ${humanBytes(USAGE.quota)} used — click for files`,
      onclick: () => filesPanel(active),
    },
      el('span', { class: 'meta' }, 'Storage'),
      el('span', { class: `a-meter a-lv-${USAGE.level}`, style: 'width:58px;display:block' },
        el('div', { style: `width:${Math.min(100, USAGE.fraction * 100)}%` }))));
  }

  slot.append(el('button', {
    title: UI ? 'Workspaces, files and sharing' : 'Sign in to share a workspace',
    onclick: () => (UI ? workspacePicker() : signInForm()),
  }, active ? `☁ ${active.name}` : (UI ? 'Choose workspace' : 'Sign in')));

  if (UI && !active) {
    slot.append(el('span', { class: 'meta', style: 'margin-left:6px' },
      UI.user.approved ? 'local storage' : 'local only'));
  }
}

/* --------------------------------------------------------- quota surfacing */

/**
 * Refresh the header meter after a write.
 *
 * Exported so the ingest path can call it: the moment usage changes is the
 * moment someone cares about it, and a meter that only updates when the
 * panel is reopened would let a reviewer upload straight into a refusal.
 */
export async function noteUsageChanged() {
  if (Backend.storageMode_() !== Backend.STORAGE_CLOUD) return;
  await refreshUsage();
  paintHeader();
}

/* ------------------------------------------------------------------ mount */

export async function mountAccountUI({ onSwitch } = {}) {
  if (onSwitch) ONSWITCH = onSwitch;

  // Every cloud write broadcasts the new usage, so the header meter tracks
  // an upload as it happens rather than going stale until someone reopens
  // the panel. Free: the figure is already in the response.
  window.addEventListener('mriseg:usage', (e) => {
    USAGE = e.detail;
    paintHeader();
  });

  try {
    const { user } = await api('/api/auth/me');
    if (user) {
      UI = { user, workspaces: [], activeId: null };
      await loadWorkspaces();
    }
  } catch {
    // 401, or no backend at all. Both mean "carry on locally" -- the page is
    // still deployable as a pure static site, and there the Sign in button
    // simply never succeeds.
  }
  paintHeader();
}
