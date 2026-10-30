/**
 * Create an account against a running server.
 *
 *   node seed-user.mjs --user exd316 --name "Ada Lovelace" --password "..."
 *   node seed-user.mjs --url https://example.org --user ... --name ... --password ...
 *
 * It posts to /api/auth/register -- the same endpoint the sign-in screen
 * uses. An earlier version generated SQL and applied it with `d1 execute`,
 * which was worse in two ways: it reimplemented the password hashing (a
 * second copy to keep in step with src/auth.js, where a silent drift shows up
 * only as a login that mysteriously fails), and it wrote the name and
 * password into a .sql file on disk. This leaves no artifact and exercises
 * the real code path, so a seeded account proves registration works.
 *
 * No credentials are baked in. Pass them on the command line.
 */

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const url = arg('--url', 'http://127.0.0.1:8787').replace(/\/$/, '');
const username = arg('--user');
const displayName = arg('--name');
const password = arg('--password');

if (!username || !displayName || !password) {
  console.error('usage: node seed-user.mjs --user <username> --name "<display name>" '
              + '--password <password> [--url http://127.0.0.1:8787]');
  process.exit(2);
}

let response;
try {
  response = await fetch(`${url}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, displayName, password }),
  });
} catch (e) {
  console.error(`could not reach ${url} -- is the server running? (${e.message})`);
  process.exit(1);
}

const body = await response.json().catch(() => ({}));
if (!response.ok) {
  console.error(`registration failed: ${body.error || response.status}`);
  process.exit(1);
}

console.log(`created ${body.user.username} (${body.user.displayName}）`.replace('）', ')'));
console.log('a personal workspace was created with it; sign in to open it.');
