/**
 * Sign in, register, and choose a workspace.
 *
 * Built in JavaScript rather than markup because the page's CSP forbids
 * inline script and this whole surface is conditional: a reviewer working
 * offline against their own browser never needs to see any of it.
 *
 * THE DEFAULT IS LOCAL, AND THAT IS THE POINT.
 * This tool has been in use with results held in IndexedDB. Booting straight
 * into a sign-in wall would have left those people staring at a login screen
 * with their cohort apparently gone -- it would still be on disk, but
 * unreachable, which is the same thing from where they sit. So the page opens
 * exactly as it did, and "Sign in" is a button in the header. Switching back
 * to the local workspace is always one click, and nothing here ever deletes
 * local data.
 */

import * as Backend from './backend.js';

let UI = null;          // { user, workspaces, activeId }
let ONSWITCH = () => {};

/* ------------------------------------------------------------------ fetch */

async function api(path, options = {}) {
  const r = await fetch(path, { credentials: 'same-origin', ...options });
  let body = null;
  try { body = await r.json(); } catch { /* some responses have no body */ }
  if (!r.ok) throw new Error(body?.error || `${r.status} ${r.statusText}`);
  return body;
}

const postJson = (path, data) => api(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data),
});

/* --------------------------------------------------------------- elements */

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const S = {
  modal: 'position:fixed;inset:0;background:rgba(15,23,42,.55);display:flex;'
       + 'align-items:center;justify-content:center;z-index:9000;padding:20px',
  card: 'background:#fff;border-radius:14px;max-width:440px;width:100%;'
      + 'padding:26px 28px;box-shadow:0 20px 60px rgba(0,0,0,.3);'
      + 'font:14px/1.55 system-ui,-apple-system,sans-serif;max-height:90vh;overflow:auto',
  h: 'margin:0 0 4px;font-size:19px;font-weight:650',
  sub: 'margin:0 0 18px;color:#64748b;font-size:13px',
  label: 'display:block;font-weight:600;margin:12px 0 4px;font-size:13px',
  input: 'width:100%;padding:9px 11px;border:1px solid #cbd2da;border-radius:8px;'
       + 'font:14px system-ui;box-sizing:border-box',
  primary: 'width:100%;padding:10px;margin-top:18px;border:0;border-radius:8px;'
         + 'background:#2563eb;color:#fff;font:600 14px system-ui;cursor:pointer',
  ghost: 'background:none;border:0;color:#2563eb;cursor:pointer;font:13px system-ui;'
       + 'padding:0;text-decoration:underline',
  err: 'background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;padding:9px 11px;'
     + 'border-radius:8px;margin-top:14px;font-size:13px',
  row: 'display:flex;align-items:center;justify-content:space-between;gap:10px;'
     + 'padding:9px 0;border-bottom:1px solid #eef1f4',
};

function closeModal() { document.getElementById('acctModal')?.remove(); }

function showModal(buildBody) {
  closeModal();
  const body = el('div', { style: S.card });
  const overlay = el('div', { id: 'acctModal', style: S.modal, onclick: (e) => {
    if (e.target === overlay) closeModal();
  } }, body);
  // Escape closes, which people expect and which matters more than usual
  // here: this overlay can appear over a half-finished mask edit.
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  document.body.append(overlay);
  buildBody(body);
  body.querySelector('input')?.focus();
  return body;
}

function errorInto(parent, message) {
  parent.querySelector('.acct-err')?.remove();
  parent.append(el('div', { class: 'acct-err', style: S.err }, message));
}

/* ------------------------------------------------------------ sign in box */

function signInForm() {
  showModal((body) => {
    const render = (mode) => {
      body.replaceChildren();
      const registering = mode === 'register';

      body.append(
        el('h2', { style: S.h }, registering ? 'Create an account' : 'Sign in'),
        el('p', { style: S.sub }, registering
          ? 'An account gives you a workspace you can share with colleagues.'
          : 'Sign in to open a shared workspace.'),
      );

      const fields = {};
      const addField = (key, label, type = 'text', hint = null) => {
        body.append(el('label', { style: S.label }, label));
        fields[key] = el('input', { style: S.input, type, autocomplete:
          type === 'password' ? (registering ? 'new-password' : 'current-password') : 'username' });
        body.append(fields[key]);
        if (hint) body.append(el('div', { style: 'color:#94a3b8;font-size:12px;margin-top:3px' }, hint));
      };

      if (registering) addField('displayName', 'Your name', 'text');
      addField('username', 'Username', 'text',
        registering ? '3-32 characters: letters, digits, dot, dash or underscore.' : null);
      addField('password', 'Password', 'password',
        registering ? 'At least 8 characters. Length beats punctuation.' : null);

      const submit = el('button', { style: S.primary },
        registering ? 'Create account' : 'Sign in');

      const go = async () => {
        submit.disabled = true;
        submit.textContent = registering ? 'Creating…' : 'Signing in…';
        try {
          const payload = registering
            ? { username: fields.username.value, password: fields.password.value,
                displayName: fields.displayName.value }
            : { username: fields.username.value, password: fields.password.value };
          const { user } = await postJson(
            registering ? '/api/auth/register' : '/api/auth/login', payload);
          UI = { user, workspaces: [], activeId: null };
          await loadWorkspaces();
          workspacePicker();
        } catch (e) {
          errorInto(body, e.message);
          submit.disabled = false;
          submit.textContent = registering ? 'Create account' : 'Sign in';
        }
      };

      submit.addEventListener('click', go);
      for (const f of Object.values(fields)) {
        f.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      }

      body.append(submit, el('div', { style: 'margin-top:14px;text-align:center' },
        el('button', { style: S.ghost, onclick: () => render(registering ? 'login' : 'register') },
          registering ? 'I already have an account' : 'Create an account')));

      body.querySelector('input')?.focus();
    };
    render('login');
  });
}

/* --------------------------------------------------------- workspace list */

async function loadWorkspaces() {
  const { workspaces } = await api('/api/workspaces');
  UI.workspaces = workspaces;
}

function workspacePicker() {
  showModal((body) => {
    body.append(
      el('h2', { style: S.h }, 'Workspaces'),
      el('p', { style: S.sub }, `Signed in as ${UI.user.displayName} (${UI.user.username}).`),
    );

    for (const w of UI.workspaces) {
      const open = el('button', {
        style: 'padding:6px 12px;border:1px solid #2563eb;background:#fff;color:#2563eb;'
             + 'border-radius:7px;font:600 13px system-ui;cursor:pointer',
        onclick: () => openWorkspace(w),
      }, UI.activeId === w.id ? 'Open' : 'Open');

      body.append(el('div', { style: S.row },
        el('div', {},
          el('div', { style: 'font-weight:600' }, w.name),
          el('div', { style: 'color:#64748b;font-size:12px' },
            `${w.n_cases} scan(s) · ${w.n_members} member(s) · you are ${w.role}`)),
        el('div', { style: 'display:flex;gap:6px' },
          w.role === 'owner'
            ? el('button', { style: 'padding:6px 10px;border:1px solid #cbd2da;background:#fff;'
                + 'border-radius:7px;font:13px system-ui;cursor:pointer',
                onclick: () => manageMembers(w) }, 'Share')
            : null,
          open)));
    }

    const nameInput = el('input', { style: S.input, placeholder: 'New workspace name' });
    body.append(
      el('label', { style: S.label }, 'Create another workspace'),
      nameInput,
      el('button', {
        style: S.primary,
        onclick: async () => {
          if (!nameInput.value.trim()) return;
          try {
            await postJson('/api/workspaces', { name: nameInput.value.trim() });
            await loadWorkspaces();
            workspacePicker();
          } catch (e) { errorInto(body, e.message); }
        },
      }, 'Create workspace'),
      el('div', { style: 'margin-top:16px;display:flex;justify-content:space-between' },
        el('button', { style: S.ghost, onclick: switchToLocal },
          'Use this browser\'s local workspace instead'),
        el('button', { style: S.ghost, onclick: signOut }, 'Sign out')),
    );
  });
}

function manageMembers(w) {
  showModal(async (body) => {
    body.append(
      el('h2', { style: S.h }, 'Share this workspace'),
      el('p', { style: S.sub }, `"${w.name}" — people you add see every scan in it, `
        + 'and can outline them in their own layer.'),
    );
    const list = el('div', {});
    body.append(list);

    const paint = async () => {
      const { members } = await api(`/api/w/${w.id}/members`);
      list.replaceChildren();
      for (const m of members) {
        list.append(el('div', { style: S.row },
          el('div', {},
            el('div', { style: 'font-weight:600' }, m.display_name),
            el('div', { style: 'color:#64748b;font-size:12px' }, `${m.username} · ${m.role}`)),
          m.role === 'owner' ? el('span', { style: 'color:#94a3b8;font-size:12px' }, 'owner')
            : el('button', {
                style: 'padding:5px 9px;border:1px solid #fecaca;background:#fff;color:#b91c1c;'
                     + 'border-radius:7px;font:13px system-ui;cursor:pointer',
                onclick: async () => {
                  try { await api(`/api/w/${w.id}/members/${m.id}`, { method: 'DELETE' }); await paint(); }
                  catch (e) { errorInto(body, e.message); }
                },
              }, 'Remove')));
      }
    };
    await paint();

    const userInput = el('input', { style: S.input, placeholder: 'their username' });
    const roleSel = el('select', { style: S.input },
      el('option', { value: 'editor' }, 'Editor — can outline and review'),
      el('option', { value: 'viewer' }, 'Viewer — can look, not change'));

    body.append(
      el('label', { style: S.label }, 'Add someone by username'),
      userInput, el('div', { style: 'height:8px' }), roleSel,
      el('div', { style: 'color:#94a3b8;font-size:12px;margin-top:6px' },
        'They need an account first — they can create one from the sign-in screen.'),
      el('button', {
        style: S.primary,
        onclick: async () => {
          try {
            await postJson(`/api/w/${w.id}/members`,
              { username: userInput.value.trim(), role: roleSel.value });
            userInput.value = '';
            await paint();
            await loadWorkspaces();
          } catch (e) { errorInto(body, e.message); }
        },
      }, 'Add to workspace'),
      el('div', { style: 'margin-top:14px;text-align:center' },
        el('button', { style: S.ghost, onclick: workspacePicker }, 'Back to workspaces')),
    );
  });
}

/* ------------------------------------------------------------- switching */

async function openWorkspace(w) {
  closeModal();
  UI.activeId = w.id;
  await Backend.useStorage(Backend.STORAGE_CLOUD, { workspaceId: w.id, user: UI.user });
  paintHeader();
  await ONSWITCH();
}

async function switchToLocal() {
  closeModal();
  if (UI) UI.activeId = null;
  await Backend.useStorage(Backend.STORAGE_LOCAL);
  paintHeader();
  await ONSWITCH();
}

async function signOut() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* going anyway */ }
  UI = null;
  await switchToLocal();
}

/* ---------------------------------------------------------------- header */

function paintHeader() {
  const slot = document.getElementById('acctSlot');
  if (!slot) return;
  slot.replaceChildren();

  const active = UI?.activeId && UI.workspaces.find((w) => w.id === UI.activeId);
  const btn = el('button', {
    style: 'padding:5px 11px;border:1px solid #cbd2da;background:#fff;border-radius:7px;'
         + 'font:13px system-ui;cursor:pointer;white-space:nowrap',
    title: UI ? 'Workspaces and sharing' : 'Sign in to share a workspace',
    onclick: () => (UI ? workspacePicker() : signInForm()),
  }, active ? `☁ ${active.name}` : (UI ? 'Choose workspace' : 'Sign in'));

  slot.append(btn);
  if (UI && !active) {
    slot.append(el('span', { style: 'color:#94a3b8;font-size:12px;margin-left:8px' },
      'local workspace'));
  }
}

/* ------------------------------------------------------------------ mount */

export async function mountAccountUI({ onSwitch } = {}) {
  if (onSwitch) ONSWITCH = onSwitch;

  // An existing cookie means a signed-in reviewer came back. Restore the
  // account, but NOT the workspace -- reopening a cohort should be a choice,
  // so that someone who left mid-edit in their local store finds it where
  // they left it.
  try {
    const { user } = await api('/api/auth/me');
    if (user) { UI = { user, workspaces: [], activeId: null }; await loadWorkspaces(); }
  } catch {
    // 401, or no backend at all. Both mean "carry on locally" -- this page
    // is still deployable as a pure static site with no server behind it,
    // and in that configuration the Sign in button simply never succeeds.
  }
  paintHeader();
}
