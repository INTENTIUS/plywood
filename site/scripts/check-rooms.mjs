// Runs after `astro build` (npm run build) and fails it when the home page, a
// room page or src/data/rooms.ts links something that leads nowhere: a site
// page or #anchor missing from dist/, or a file in this repository (a
// github.com/INTENTIUS/plywood blob or tree link on main) missing from the
// checkout. A link to a draft page counts as resolving on a production build,
// which leaves drafts out and renders such links as text.
// It also fails when a published room's page was not built, when a room has
// no page under src/content/docs/for/, and when the sidebar's "Your setup"
// group and the rooms of rooms.ts disagree. Adapted from plunge's
// site/scripts/check-rooms.mjs. Node runs rooms.ts directly, since it strips
// the types.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOMS, ROOM_ORDER, roomLinks } from '../src/data/rooms.ts';
import { SIDEBAR } from '../src/data/sidebar.mjs';
import { docPages, sitePath } from '../src/lib/pages.mjs';

const base = '/plywood';
const site = fileURLToPath(new URL('..', import.meta.url));
const root = resolve(site, '..');
const dist = join(site, 'dist');
const repoLink = /^https:\/\/github\.com\/INTENTIUS\/plywood\/(?:blob|tree)\/main\/([^#?]+)/;
const problems = [];
const pages = docPages();
const drafts = new Set(pages.filter((p) => p.draft).map((p) => p.path));
const known = new Set(pages.map((p) => p.path));

const ids = new Map();
const idsOf = (file) => {
	if (!ids.has(file)) ids.set(file, new Set([...readFileSync(file, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
	return ids.get(file);
};

/** The built file a site path is served from, or undefined. */
const target = (path) => {
	const p = join(dist, decodeURIComponent(path.slice(base.length)));
	if (existsSync(p) && statSync(p).isFile()) return p;
	if (existsSync(join(p, 'index.html'))) return join(p, 'index.html');
	return undefined;
};

/** Why an address leads nowhere, or undefined when it resolves. `from` is the built page it sits on. */
const broken = (href, from) => {
	const repo = href.match(repoLink);
	if (repo) {
		const path = decodeURIComponent(repo[1]).replace(/\/$/, '');
		return existsSync(join(root, path)) ? undefined : `${href}: ${path} is not in the repository`;
	}
	if (/^(https?:|mailto:|data:|\/\/)/.test(href)) return undefined;
	const [path, anchor] = href.split('#');
	let file = from;
	if (path) {
		if (!path.startsWith(`${base}/`)) return `${href} is outside ${base}/`;
		file = target(path.split('?')[0]);
		if (!file) {
			const key = sitePath(path);
			if (drafts.has(key)) return undefined;
			return `${href} leads nowhere`;
		}
	}
	if (anchor && file?.endsWith('.html') && !idsOf(file).has(decodeURIComponent(anchor))) return `${href} names an anchor the page does not have`;
	return undefined;
};

if (!existsSync(dist)) {
	console.error('site/dist is missing: run astro build first');
	process.exit(1);
}

// The links as rooms.ts writes them. A site path must name a docs page.
for (const l of roomLinks()) {
	if (!/^https?:/.test(l.href) && !known.has(sitePath(l.href))) problems.push(`src/data/rooms.ts: ${l.where} links "${l.label}" to ${l.href}, which no docs page has`);
	const why = broken(/^https?:/.test(l.href) ? l.href : `${base}${l.href}`);
	if (why) problems.push(`src/data/rooms.ts: ${l.where} links "${l.label}": ${why}`);
}

// Every room has its page, and a published room's page was built.
for (const id of ROOM_ORDER) {
	const path = `/for/${id}/`;
	if (!known.has(path)) problems.push(`src/content/docs/for/${id}.mdx: the room has no page`);
	else if (!drafts.has(path) && !existsSync(join(dist, 'for', id, 'index.html'))) problems.push(`dist/for/${id}/: the room page was not built`);
}

// Every link in the main column of the built home page and room pages.
const built = [join(dist, 'index.html'), ...ROOM_ORDER.map((id) => join(dist, 'for', id, 'index.html'))].filter(existsSync);
for (const f of built) {
	const page = readFileSync(f, 'utf8');
	const start = page.indexOf('<main');
	const html = start === -1 ? '' : page.slice(start, page.lastIndexOf('</main>'));
	if (!html) problems.push(`${relative(dist, f)}: no <main> to check`);
	for (const [, raw] of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
		const why = broken(raw.replace(/&amp;/g, '&'), f);
		if (why) problems.push(`${relative(dist, f)}: ${why}`);
	}
}

// The sidebar's "Your setup" group, against the rooms: same rooms, same order, same titles.
const setup = SIDEBAR.find((g) => g.label === 'Your setup');
const listed = (setup?.items ?? []).map((x) => ({ label: x.label, id: x.slug.replace(/^for\//, '') }));
if (listed.map((x) => x.id).join(' ') !== ROOM_ORDER.join(' ')) {
	problems.push(`src/data/sidebar.mjs: "Your setup" lists ${listed.map((x) => x.id).join(', ') || 'no room'}, but rooms.ts has ${ROOM_ORDER.join(', ')}`);
}
for (const x of listed) {
	const r = ROOMS.find((y) => y.id === x.id);
	if (r && r.title !== x.label) problems.push(`src/data/sidebar.mjs: "Your setup" calls /for/${x.id}/ "${x.label}", but its room is titled "${r.title}"`);
}

// Every sidebar entry names a docs page.
const walk = (items) => {
	for (const i of items) {
		if (i.items) walk(i.items);
		else if (i.slug !== undefined && !known.has(i.slug === '' ? '/' : `/${i.slug}/`)) problems.push(`src/data/sidebar.mjs: "${i.label}" names ${i.slug}, which no docs page has`);
	}
};
walk(SIDEBAR);

for (const p of problems) console.error(p);
if (problems.length) process.exit(1);
console.log(`rooms: ${ROOM_ORDER.length} rooms (${ROOM_ORDER.filter((id) => !drafts.has(`/for/${id}/`)).length} published) and the home page, every link resolves`);
