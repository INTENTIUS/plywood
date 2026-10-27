// Site links for components. A production build leaves draft pages out, so a
// component link to one renders as plain text there (live() is false); the dev
// server keeps every link. Markdown links get the same treatment from the
// rehype plugin in astro.config.mjs.
import { draftPaths, sitePath } from './pages.mjs';

const drafts: Set<string> = import.meta.env.PROD ? draftPaths() : new Set();

export const base = import.meta.env.BASE_URL.replace(/\/$/, '');

export const external = (h: string) => /^https?:/.test(h);

/** A site path ('/guides/x/') or a full address, as an href. */
export const href = (h: string) => (external(h) ? h : `${base}${h}`);

/** Whether this build has the page a link points at. */
export const live = (h: string) => external(h) || !drafts.has(sitePath(h));
