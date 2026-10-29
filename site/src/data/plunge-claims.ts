// The plunge claims plywood's pages credit, by id. Each <WithPlunge claim="...">
// names one, and scripts/check-claims.mjs fails the build on an id missing
// here, on a <WithPlunge> with no claim, and on a `row` that plunge's claims
// page (https://intentius.io/plunge/claims/) has no recorded run for.
//
// `row` is the start of the run's first cell on plunge's page
// (site/src/content/docs/claims.md in the plunge repository). A claim with no
// `row` has no recorded run on that page yet; `waits` says what it waits on.
// Nothing here renders: the aside only links plunge's page.

export type PlungeClaim = {
	id: string;
	/** What the claim says, as the aside's feature clause words it. */
	says: string;
	/** The start of the run's first cell on plunge's claims page. */
	row?: string;
	/** Why plywood credits no recorded run yet. */
	waits?: string;
};

export const PLUNGE_CLAIMS_DATA: PlungeClaim[] = [
	{
		id: 'markers-and-records',
		says: 'markers on each resource and a record per resource',
		row: '`plunge up` of `tests/plunge-corpus/aws-ts` on `plunge+file://`',
	},
	{
		id: 'drift-per-resource',
		says: 'drift read per resource with one provider read and no program run',
		row: '`plunge drift --resource <urn> --stream` on three resources of the same stack',
	},
	{
		id: 'concurrent-updates',
		says: 'two updates to different resources of one stack run side by side, with no stack lock',
		waits: 'plunge#6: its maintainer run, which the races lifecycle row on plunge\'s page records, is credited here once plunge#6 closes; the refresh fix is on plunge main, so it waits on the plunge release after 0.1.0',
	},
	{
		id: 'record-per-resource',
		says: 'a record per resource with conditional writes in place of a stack lock',
		waits: 'plunge#6, as concurrent-updates, and the plunge release after 0.1.0',
	},
	{
		id: 'per-resource-progress',
		says: 'per-resource timings of each provider call and record write during up',
		waits: 'plunge#55: a recorded plunge up --json with its timings; the timings are on plunge main, so it waits on the plunge release after 0.1.0',
	},
	{
		id: 'markers-ownership',
		says: "each resource's owner from its markers, and a graph read from records",
		waits: 'plunge#40, closed on 2026-10-28 with its fix on plunge main after 0.1.0: the maintainer run of plunge graph --json is credited here once a plunge release after 0.1.0 carries it',
	},
];

export const PLUNGE_CLAIM_IDS = new Set(PLUNGE_CLAIMS_DATA.map((c) => c.id));
