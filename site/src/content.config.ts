import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { docsLoader, i18nLoader } from '@astrojs/starlight/loaders';
import { docsSchema, i18nSchema } from '@astrojs/starlight/schema';
import { promptText } from './prompts';

export const collections = {
	i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
	docs: defineCollection({
		loader: docsLoader(),
		schema: docsSchema({
			extend: z.object({
				// The issues a page's feature waits on: chant#4541, plunge#6,
				// plywood#1, or TBD-<slug> for a gap with no issue. A page with
				// needs is a draft; scripts/check-needs.mjs holds the two together.
				needs: z.array(z.string().regex(/^((chant|plunge|plywood)#\d+|TBD-[a-z0-9-]+)$/)).default([]),
				// "Optional: hand this page to your coding agent". `prompt: setup` is
				// the setup prompt from src/prompts.ts.
				prompt: z.string().optional().transform(promptText),
			}),
		}),
	}),
};
