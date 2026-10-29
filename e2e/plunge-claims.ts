// The plunge features plywood's pages describe, by id, with the run each
// rests on. EVIDENCE.md renders this list (e2e/evidence.ts).
//
// `row` is the start of the run's first cell on plunge's own evidence page.
// A feature with no `row` has no recorded run there yet; `waits` says what
// it waits on.

export type PlungeClaim = {
	id: string;
	/** What the claim says. */
	says: string;
	/** The start of the run's first cell on plunge's evidence page. */
	row?: string;
	/** Why no recorded run is listed yet. */
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
