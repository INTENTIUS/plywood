// The agent index, built from the docs collection so it never drifts from the
// site. llms.txt lists every page; llms-full.txt carries their text. A
// production build lists only the pages it publishes.
import { getCollection } from 'astro:content';
import { bodyMarkdown, pageUrl } from '../markdown';
import { neverLine } from '../prompts';

const ORDER = ['index', 'getting-started', 'concepts/how-it-works', 'reference/validation', 'concepts/glossary'];

export async function pages() {
	const docs = (await getCollection('docs')).filter((d) => !(import.meta.env.PROD && d.data.draft));
	const rank = (id: string) => {
		const i = ORDER.indexOf(id);
		return i === -1 ? ORDER.length : i;
	};
	return docs
		.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id))
		.map((d) => ({
			id: d.id,
			title: d.data.title,
			description: d.data.description ?? '',
			url: pageUrl(d.id),
			prompt: d.data.prompt?.replace(neverLine, '').trim(),
			body: bodyMarkdown(d.body ?? ''),
		}));
}

export const PREAMBLE = `# plywood

> CI Automation for Pulumi

plywood runs Pulumi previews and updates from pull requests on GitHub, GitLab or Forgejo. It posts one preview note for every stack a change reaches, binds each approval to a preview digest, and rolls changes out in waves. It runs on chant's runtime, and plunge, the Pulumi fork from the team behind plywood, adds resource-level features.

The source is at https://github.com/INTENTIUS/plywood.

A page's prompt sits under "Optional: hand this page to your coding agent" and in llms.txt under the page. Every prompt ends with this rule, left out below: ${neverLine}`;
