// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { BASE, draftPaths, sitePath } from './src/lib/pages.mjs';
import { SIDEBAR } from './src/data/sidebar.mjs';

// expressive-code renders each code line as its own block element with no
// newline between them, so text extracted from the page (an agent, a reader
// mode, a copy of the selection) runs lines together. A newline text node as the
// last child of each line fixes that. Copied from plunge's site/astro.config.mjs.
const newlinesBetweenLines = {
	name: 'newlines-between-lines',
	hooks: {
		postprocessRenderedBlock: ({ renderData }) => {
			const visit = (node) => {
				if (!node.children) return;
				const lines = node.children.filter((c) => c.type === 'element' && (c.properties?.className ?? []).includes('ec-line'));
				for (const line of lines.slice(0, -1)) {
					const code = line.children.find((c) => c.type === 'element');
					if (code && !code.children.some((c) => c.type === 'element')) continue;
					line.children.push({ type: 'text', value: '\n' });
				}
				node.children.forEach(visit);
			};
			visit(renderData.blockAst);
		},
	},
};

// A production build leaves draft pages out (ruling 2: `needs:` plus `draft`).
// The sidebar then drops their entries. scripts/unwrap-draft-links.mjs turns a
// link to a draft from a published page into its text after the build, and a
// link to a page that does not exist at all stays a link, so
// scripts/check-links.mjs still catches it.
const production = process.argv.includes('build');
const drafts = production ? draftPaths() : new Set();

function sidebar(items) {
	return items
		.map((item) => {
			if (item.items) {
				const kept = sidebar(item.items);
				return kept.length ? { ...item, items: kept } : undefined;
			}
			const path = item.slug !== undefined ? (item.slug === '' ? '/' : `/${item.slug}/`) : sitePath(item.link);
			return drafts.has(path) ? undefined : item;
		})
		.filter(Boolean);
}

// Published under the org domain at /plywood, as plunge is at /plunge and
// terragucci at /terragucci. `base` has to match or every internal link 404s
// on Pages.
export default defineConfig({
	site: 'https://intentius.io',
	base: BASE,
	integrations: [
		starlight({
			title: 'plywood',
			// src/pages/404.astro is the 404 page.
			disable404Route: true,
			// The board's image files live in public/ and are referenced by URL.
			// SiteTitle.astro draws the logo and the wordmark.
			favicon: '/favicon.ico',
			head: [
				{ tag: 'link', attrs: { rel: 'icon', type: 'image/png', href: '/plywood/favicon-32.png', sizes: '32x32' } },
				{ tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/plywood/apple-touch-icon.png' } },
				{ tag: 'meta', attrs: { property: 'og:image', content: 'https://intentius.io/plywood/plywood-share.png' } },
				{ tag: 'meta', attrs: { property: 'og:image:width', content: '400' } },
				{ tag: 'meta', attrs: { property: 'og:image:height', content: '400' } },
				{ tag: 'meta', attrs: { property: 'og:image:alt', content: 'The plywood board: a pixel-art plywood plank' } },
				{ tag: 'meta', attrs: { name: 'twitter:card', content: 'summary' } },
				{ tag: 'meta', attrs: { name: 'twitter:image', content: 'https://intentius.io/plywood/plywood-share.png' } },
			],
			expressiveCode: { plugins: [newlinesBetweenLines] },
			customCss: ['./src/styles/plywood.css'],
			components: {
				Head: './src/components/Head.astro',
				PageTitle: './src/components/PageTitle.astro',
				Footer: './src/components/Footer.astro',
				SocialIcons: './src/components/SocialIcons.astro',
				SiteTitle: './src/components/SiteTitle.astro',
				ThemeProvider: './src/components/ThemeProvider.astro',
				ThemeSelect: './src/components/ThemeSelect.astro',
			},
			description: 'CI Automation for Pulumi',
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/INTENTIUS/plywood' }],
			editLink: {
				baseUrl: 'https://github.com/INTENTIUS/plywood/edit/main/site/',
			},
			sidebar: sidebar(SIDEBAR),
		}),
	],
});
