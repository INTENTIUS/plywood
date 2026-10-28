// The doors and rooms of the site (terragucci's design/doors-and-rooms.md).
// The picker on the home page reads every list here, and each page under
// for/ renders one room with Room.astro. A room opens with the features, then
// the differences and the first step; its links then go how-to, explanation,
// reference. Paths are relative to the site base. scripts/check-rooms.mjs
// fails the build on a link that leads nowhere.

export type Link = { label: string; href: string };

export type Room = {
	id: string;
	title: string;
	/** One line: who the room is for. */
	lede: string;
	works: string[];
	differs: string[];
	first: Link;
	howto: Link[];
	explain: Link[];
	reference: Link[];
};

export const PLUNGE_CLAIMS = 'https://intentius.io/plunge/claims/';

/** Every room can count on these, whatever backend or engine it runs. */
export const ASSUMED: Link[] = [
	{ label: 'One preview note on every pull request', href: '/getting-started/' },
	{ label: 'Updates of the previews you approved', href: '/guides/approve-a-wave/' },
	{ label: 'No overlapping or stale updates', href: '/concepts/locking-and-staleness/' },
	{ label: 'Re-preview from a comment', href: '/guides/re-preview-from-a-comment/' },
	{ label: 'Scheduled drift checks', href: '/guides/turn-on-drift-checks/' },
	{ label: 'Separate identities to preview and to update', href: '/guides/scope-state-access/' },
	{ label: 'Policy on every preview, CrossGuard included', href: '/guides/use-policy-packs/' },
	{ label: 'An audit trail in your own repository', href: '/guides/read-the-audit-trail/' },
	{ label: 'Secrets stay [secret] in notes', href: '/reference/report/' },
	{ label: 'Your backend and your runners, as they are', href: '/reference/backends/' },
];

/** plywood leaves these to your forge, your cloud and Pulumi. Shown on the home page. */
export const LIMITS: { label: string; why: string }[] = [
	{ label: 'Bitbucket and Azure DevOps', why: 'init writes pipelines for GitHub, GitLab and Forgejo.' },
	{ label: 'Accounts and roles of its own', why: 'Your forge decides who approves, and your cloud decides each job\'s reach.' },
	{ label: 'A hosted service', why: 'Every job runs in your CI and writes to your repository.' },
	{ label: 'Programs and providers', why: 'Pulumi runs your program, in any language it supports.' },
];

/** The engines: what each adds to a room, and its page. */
export const ENGINES: { id: string; label: string; adds: string[]; href: string }[] = [
	{ id: 'pulumi', label: 'Pulumi', adds: [], href: '/guides/choose-an-engine/' },
	{
		id: 'plunge',
		label: 'plunge',
		adds: [
			'Updates to different resources of one stack run side by side',
			'A saved plan refuses records that moved after review',
			'Drift read per resource, with no program run',
		],
		href: '/guides/choose-an-engine/',
	},
];

/** The backends, each a tile on the picker. */
export const BACKENDS: { id: string; label: string; blurb: string; room: string; first: Link }[] = [
	{ id: 'cloud', label: 'Pulumi Cloud', blurb: 'State, ESC and Insights in Pulumi Cloud', room: 'pulumi-cloud', first: { label: 'Get your first preview note', href: '/getting-started/' } },
	{ id: 'diy', label: 'Self-managed', blurb: 'Your own bucket or directory', room: 'diy-backend', first: { label: 'Get your first preview note', href: '/getting-started/' } },
	{ id: 'plunge', label: 'plunge', blurb: 'A plunge+ backend URL', room: 'plunge', first: { label: 'Choose pulumi or plunge', href: '/guides/choose-an-engine/' } },
];

/** The repo shapes, each a tile on the picker. */
export const SHAPES: { id: string; label: string; blurb: string; room: string }[] = [
	{ id: 'stacks', label: 'One program', blurb: 'A stack per environment or region', room: 'many-stacks' },
	{ id: 'projects', label: 'Many projects', blurb: 'Stack references between them', room: 'many-projects' },
	{ id: 'repos', label: 'Many repositories', blurb: 'One control repo for all', room: 'many-repos' },
];

export const ROLES: { label: string; room: string }[] = [
	{ label: 'Security review', room: 'security' },
	{ label: 'Evaluating plywood', room: 'evaluate' },
	{ label: 'Working with a coding agent', room: 'agents' },
];

const firstNote = { label: 'Get your first preview note', href: '/getting-started/' };
const addToRepo = { label: 'Add plywood to a repo', href: '/guides/add-to-a-repo/' };
const howItWorks = { label: 'Architecture', href: '/concepts/how-it-works/' };
const waves = { label: 'Waves and approvals', href: '/concepts/waves-and-approvals/' };
const locking = { label: 'Locking and staleness', href: '/concepts/locking-and-staleness/' };
const config = { label: 'Configuration', href: '/reference/config/' };
const backends = { label: 'Backends', href: '/reference/backends/' };
const stages = { label: 'Stages', href: '/reference/stages/' };
const claims = { label: 'Claims and runs', href: '/reference/validation/' };
const threat = { label: 'Threat model', href: '/reference/threat-model/' };

export const ROOMS: Room[] = [
	{
		id: 'pulumi-cloud',
		title: 'Pulumi Cloud stacks',
		lede: 'Your stacks live in Pulumi Cloud, and you want previews and updates to run from your own forge\'s pull requests.',
		works: [
			'State and update history stay in Pulumi Cloud next to ESC environments and Insights',
			'Previews and updates run in your forge\'s CI, logged in with a Pulumi Cloud token traded from the job\'s OIDC token',
			'Stock Pulumi resolves each stack\'s ESC environments on the Pulumi Cloud backend with that token',
			'Pulumi Cloud\'s stack lock keeps updates to a stack in order',
			'An approval binds the preview digest, on top of Pulumi Cloud\'s own controls',
		],
		differs: [
			'For the stacks plywood runs, your forge\'s CI starts each update in place of Pulumi Deployments.',
			'The preview job and the update job log in with separate access tokens.',
		],
		first: firstNote,
		howto: [addToRepo, { label: 'Alongside Pulumi Deployments', href: '/guides/alongside-pulumi-deployments/' }, { label: 'Scope state and cloud access', href: '/guides/scope-state-access/' }],
		explain: [howItWorks, waves],
		reference: [backends, config],
	},
	{
		id: 'diy-backend',
		title: 'Self-managed backends',
		lede: 'You keep state in a directory, or in a cloud storage bucket you run.',
		works: [
			'The backend works as it is, with nothing to move',
			'A target lock per stack keeps two pull requests from updating one stack at once',
			'The stack export after each update is the record the graph and checks read',
		],
		differs: ['plywood keeps its approvals and locks on the chant/lifecycle branch of your repository, next to the backend.'],
		first: firstNote,
		howto: [addToRepo, { label: 'Change a stack\'s backend', href: '/guides/move-a-stack-backend/' }],
		explain: [locking, howItWorks],
		reference: [backends, config],
	},
	{
		id: 'plunge',
		title: 'Stacks on plunge',
		lede: 'You run plunge (the Pulumi fork from the team behind plywood) or plan to.',
		works: [
			'A plunge+ backend URL runs every stage with plunge',
			'Two merged pull requests on separate resources of one stack update at once, since nothing locks the stack',
			'A saved plan carries the version of each record it read, and up refuses a record that moved',
			'plunge drift checks a single resource against the cloud',
			'Every resource carries plunge-stack and plunge-urn markers, and behold reads ownership from them',
		],
		differs: ['plunge keeps no stack history; bucket versioning keeps earlier versions of each record.'],
		first: { label: 'Choose pulumi or plunge', href: '/guides/choose-an-engine/' },
		howto: [{ label: 'The same repo on plunge', href: '/tutorial/plunge/' }, { label: 'Watch an update on plunge', href: '/guides/watch-a-plunge-update/' }, { label: 'Change a stack\'s backend', href: '/guides/move-a-stack-backend/' }],
		explain: [locking],
		reference: [stages, { label: 'Exit codes', href: '/reference/exit-codes/' }, { label: 'plunge claims', href: PLUNGE_CLAIMS }],
	},
	{
		id: 'many-stacks',
		title: 'One program, many stacks',
		lede: 'You run one Pulumi project and give each environment or region its own stack.',
		works: [
			'Each stack is a member, and stacks form waves',
			'The first wave in plywood.yml is the canary',
			'A later wave holds for its own approval',
		],
		differs: [],
		first: { label: 'Canary, then waves', href: '/tutorial/waves/' },
		howto: [{ label: 'Approve a wave', href: '/guides/approve-a-wave/' }, { label: 'Separate environments', href: '/guides/separate-environments/' }],
		explain: [waves, { label: 'Why previews are grouped', href: '/concepts/why-previews-are-grouped/' }],
		reference: [config, stages],
	},
	{
		id: 'many-projects',
		title: 'Many projects',
		lede: 'Several Pulumi projects read each other\'s outputs through StackReference.',
		works: [
			'Stacks update in the order their references give',
			'The note says which stack\'s preview reads another\'s outputs',
			'One note and one approval cover every project a pull request reaches',
		],
		differs: [],
		first: { label: 'Order stacks by their references', href: '/guides/stack-references/' },
		howto: [{ label: 'One note for every stack', href: '/tutorial/one-note/' }, { label: 'Approve a wave', href: '/guides/approve-a-wave/' }],
		explain: [waves],
		reference: [config],
	},
	{
		id: 'many-repos',
		title: 'Many repositories',
		lede: 'Your stacks span many repositories, and one team sets the approvers for all of them.',
		works: [
			'A control repo holds the approvers and the engine pins',
			'Each repository gets its settings as a pull request, so a change to them is reviewed like any other',
		],
		differs: [],
		first: { label: 'Govern many repositories', href: '/guides/govern-many-repos/' },
		howto: [{ label: 'Write a policy', href: '/guides/write-a-policy/' }, { label: 'Approvals runbook', href: '/guides/approvals-runbook/' }],
		explain: [{ label: 'The control repo', href: '/concepts/control-repo/' }],
		reference: [config],
	},
	{
		id: 'agents',
		title: 'With a coding agent',
		lede: 'You work with a coding agent and want it to read stacks and propose changes.',
		works: [
			'Your agent sets plywood up and opens the pull request',
			'Read-only MCP tools list stacks and their runs',
			'A model can review a pull request against its previews',
			'A person approves every update',
		],
		differs: ['Updates, approvals and merges stay with a person.'],
		first: { label: 'Set it up with your agent', href: '/getting-started/agents/' },
		howto: [{ label: 'Read your stacks over MCP', href: '/guides/agent-read-over-mcp/' }, { label: 'Have an agent review a pull request', href: '/guides/agent-review-a-pull-request/' }, { label: 'Have an agent fix drift', href: '/guides/agent-fix-drift/' }],
		explain: [howItWorks],
		reference: [threat],
	},
	{
		id: 'security',
		title: 'Security review',
		lede: 'You review the identities and approvals behind each update before plywood runs.',
		works: [
			'Preview and update run as separate cloud identities',
			'The OIDC trade happens before the pull request\'s code is checked out',
			'Approvals can be signed, and each binds one preview digest',
			'Policy and approvers are read at base',
		],
		differs: [],
		first: threat,
		howto: [{ label: 'Scope state and cloud access', href: '/guides/scope-state-access/' }, { label: 'Approvals runbook', href: '/guides/approvals-runbook/' }],
		explain: [{ label: 'Approvals are records', href: '/concepts/approvals-as-records/' }],
		reference: [threat, { label: 'Versions and pins', href: '/reference/versions-and-pins/' }],
	},
	{
		id: 'evaluate',
		title: 'Evaluate plywood',
		lede: 'You compare plywood with a pipeline you would write yourself on pulumi/actions.',
		works: [
			'A single note replaces the comment per stack that a hand-written pipeline posts',
			'An approval that stops counting once its preview moves',
			'Waves, drift and an audit trail with no service to host',
		],
		differs: ['Each claim on the claims page names its recorded run.'],
		first: claims,
		howto: [firstNote, { label: 'Boot the example', href: '/tutorial/' }],
		explain: [howItWorks],
		reference: [claims],
	},
];

export function room(id: string): Room {
	const r = ROOMS.find((x) => x.id === id);
	if (!r) throw new Error(`src/data/rooms.ts: no room ${id}`);
	return r;
}

/** Room order in the "Your setup" sidebar group. */
export const ROOM_ORDER: string[] = ROOMS.map((r) => r.id);

/** Every link here, for scripts/check-rooms.mjs. */
export function roomLinks(): (Link & { where: string })[] {
	const out: (Link & { where: string })[] = [];
	for (const r of ROOMS) {
		for (const l of [r.first, ...r.howto, ...r.explain, ...r.reference]) out.push({ ...l, where: `room ${r.id}` });
	}
	for (const b of BACKENDS) out.push({ ...b.first, where: `BACKENDS ${b.id}` });
	for (const e of ENGINES) out.push({ label: e.label, href: e.href, where: 'ENGINES' });
	for (const a of ASSUMED) out.push({ ...a, where: 'ASSUMED' });
	return out;
}
