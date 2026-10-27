// The prompts handed to a coding agent. Every prompt carries neverLine word for
// word, so none can drop the part that keeps up, approval and merge with a
// person. The setup prompt has this one source: the home page and the agents
// page render it.

export const SITE = 'https://intentius.io/plywood';

export const neverLine =
	'Never run `pulumi up`, `plunge up`, `pulumi destroy` or `plywood approve`, override a policy denial, use `--mode up`, or merge; never touch `.chant/allowed_signers` or `chant/lifecycle`.';

export const setupPrompt = [
	'Set up plywood in this repository.',
	`Read ${SITE}/llms.txt first, then`,
	`${SITE}/getting-started/agents/ and follow it.`,
	'Ask me which stacks should wait for an approval before they update.',
	'Open a pull request with the result.',
	neverLine,
].join('\n');

// A page's `prompt:` front matter, as its text. `prompt: setup` stands for the
// setup prompt, so a page can carry it without a second copy.
export function promptText(prompt: string | undefined): string | undefined {
	const text = prompt?.trim();
	if (!text) return undefined;
	return text === 'setup' ? setupPrompt : text;
}
