// The docs pages and their `needs:`, read from the files themselves. The
// config (sidebar, link unwrapping), the components and the build checks all
// read this one list, so they cannot disagree about which pages a production
// build publishes.
//
// A page whose feature waits on open issues carries `needs: [...]` and
// `draft: true`. Starlight shows drafts on the dev server and leaves them out
// of production builds; scripts/check-needs.mjs holds the two keys together.
//
// Paths are read from the working directory, which is site/ for every npm
// script and every `just site-*` recipe.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const BASE = '/plywood';
const DOCS = join(process.cwd(), 'src', 'content', 'docs');

function files(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...files(p));
		else if (/\.(md|mdx)$/.test(name)) out.push(p);
	}
	return out.sort();
}

function frontmatter(src) {
	const m = /^---\n([\s\S]*?)\n---/.exec(src);
	return m ? m[1] : '';
}

/** Every docs page: its id, its site path ('/guides/x/'), whether it is a draft, and its needs. */
export function docPages() {
	return files(DOCS).map((file) => {
		const fm = frontmatter(readFileSync(file, 'utf8'));
		const id = relative(DOCS, file).split(sep).join('/').replace(/\.(md|mdx)$/, '').replace(/(^|\/)index$/, '');
		const needsLine = /^needs:\s*\[(.*)\]\s*$/m.exec(fm);
		const needs = needsLine ? needsLine[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : [];
		return {
			file: relative(process.cwd(), file),
			id,
			path: id ? `/${id}/` : '/',
			draft: /^draft:\s*true\s*$/m.test(fm),
			needs,
		};
	});
}

/** Site paths ('/guides/x/') of the draft pages. */
export function draftPaths() {
	return new Set(docPages().filter((p) => p.draft).map((p) => p.path));
}

/** A site path without its base, query or anchor, with a trailing slash. */
export function sitePath(href) {
	let p = href.split('#')[0].split('?')[0];
	if (p.startsWith(`${BASE}/`) || p === BASE) p = p.slice(BASE.length) || '/';
	if (!p.endsWith('/')) p += '/';
	return p;
}
