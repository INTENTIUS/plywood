// The sidebar, in the order terragucci's site uses: start, tutorial, your
// setup (the rooms), already using, proof, how-to guides, reference, concepts,
// changes. Every group starts collapsed; the current page's group opens.
// astro.config.mjs drops draft pages from a production build, and a group left
// empty goes with them. The "Your setup" labels match the room titles in
// rooms.ts; scripts/check-rooms.mjs fails the build when they differ.

const group = (label, items) => ({ label, collapsed: true, items });
const page = (label, slug) => ({ label, slug });

export const SIDEBAR = [
	group('Start here', [
		page('Get your first preview note', 'getting-started'),
		page('Set it up with your agent', 'getting-started/agents'),
		page('Architecture', 'concepts/how-it-works'),
	]),
	group('Tutorial', [
		page('Boot the example', 'tutorial'),
		page('Your first pull request', 'tutorial/first-pull-request'),
		page('One note for every stack', 'tutorial/one-note'),
		page('Canary, then waves', 'tutorial/waves'),
		page('A preview that changed after review', 'tutorial/changed-preview'),
		page('Find drift', 'tutorial/drift'),
		page('The same repo on plunge', 'tutorial/plunge'),
		page('See your runs', 'tutorial/see-your-runs'),
		page('Now your repo', 'tutorial/your-repo'),
	]),
	group('Your setup', [
		page('Pulumi Cloud stacks', 'for/pulumi-cloud'),
		page('Self-managed backends', 'for/diy-backend'),
		page('Stacks on plunge', 'for/plunge'),
		page('One program, many stacks', 'for/many-stacks'),
		page('Many projects', 'for/many-projects'),
		page('Many repositories', 'for/many-repos'),
		page('With a coding agent', 'for/agents'),
		page('Security review', 'for/security'),
		page('Evaluate plywood', 'for/evaluate'),
	]),
	group('Already using', [
		page('Pulumi Deployments', 'guides/alongside-pulumi-deployments'),
		page('pulumi/actions in GitHub Actions', 'guides/from-pulumi-actions'),
		page('Change a stack\'s backend', 'guides/move-a-stack-backend'),
	]),
	group('Proof', [
		page('Claims and runs', 'reference/validation'),
		page('Scale', 'reference/scale'),
	]),
	group('How-to guides', [
		group('Add plywood', [
			page('Add plywood to a repo', 'guides/add-to-a-repo'),
			page('Choose pulumi or plunge', 'guides/choose-an-engine'),
			page('Run in a prepared image', 'guides/run-in-a-prepared-image'),
		]),
		group('Ship changes', [
			page('Approve a wave', 'guides/approve-a-wave'),
			page('Approvals runbook', 'guides/approvals-runbook'),
			page('Re-preview from a comment', 'guides/re-preview-from-a-comment'),
			page('Fix a refused wave', 'guides/fix-a-refused-wave'),
			page('Update a stack before it merges', 'guides/update-before-merge'),
			page('Preview and update a few resources', 'guides/target-resources'),
			page('A stack per pull request', 'guides/review-stacks'),
			page('Resources registered inside apply()', 'guides/resources-registered-at-up'),
			page('Run without approvals', 'guides/run-without-approvals'),
			page('Roll a stack back to a release', 'guides/roll-back-a-stack'),
		]),
		group('Policy and audit', [
			page('Write a policy', 'guides/write-a-policy'),
			page('Use your CrossGuard policy packs', 'guides/use-policy-packs'),
			page('Override a denial', 'guides/override-a-denial'),
			page('Read the audit trail', 'guides/read-the-audit-trail'),
			page('Query with SQL', 'guides/query-with-sql'),
		]),
		group('Watch and keep', [
			page('Turn on drift checks', 'guides/turn-on-drift-checks'),
			page('Keep the stack export current', 'guides/keep-the-export-current'),
			page('Notify a chat channel', 'guides/notify-a-chat-channel'),
			page('Send traces and metrics', 'guides/send-traces-and-metrics'),
			page('See your stacks in behold', 'guides/see-your-estate-in-behold'),
			page('Watch an update on plunge', 'guides/watch-a-plunge-update'),
		]),
		group('Your repo shape', [
			page('Order stacks by their references', 'guides/stack-references'),
			page('Separate environments', 'guides/separate-environments'),
			page('Scope state and cloud access', 'guides/scope-state-access'),
		]),
		group('Many repos and agents', [
			page('Govern many repositories', 'guides/govern-many-repos'),
			page('Have an agent review a pull request', 'guides/agent-review-a-pull-request'),
			page('Read your stacks over MCP', 'guides/agent-read-over-mcp'),
			page('Have an agent fix drift', 'guides/agent-fix-drift'),
		]),
	]),
	group('Reference', [
		page('CLI', 'reference/cli'),
		page('Configuration', 'reference/config'),
		page('Stages', 'reference/stages'),
		page('The report', 'reference/report'),
		page('Environment variables', 'reference/environment'),
		page('Backends', 'reference/backends'),
		page('Exit codes', 'reference/exit-codes'),
		page('Versions and pins', 'reference/versions-and-pins'),
		page('Threat model', 'reference/threat-model'),
		page('Tips', 'reference/tips'),
		page('Development', 'reference/development'),
	]),
	group('Concepts', [
		page('Glossary', 'concepts/glossary'),
		page('Approvals are records', 'concepts/approvals-as-records'),
		page('Waves and approvals', 'concepts/waves-and-approvals'),
		page('Locking and staleness', 'concepts/locking-and-staleness'),
		page('Why previews are grouped', 'concepts/why-previews-are-grouped'),
		page('The control repo', 'concepts/control-repo'),
	]),
	page('Changes', 'reference/whats-new'),
];
