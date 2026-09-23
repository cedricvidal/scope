// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

// Published articles about Scope. One YAML file per article in
// src/content/articles/; the file name is the entry id.
const articles = defineCollection({
	loader: glob({ pattern: '**/*.yaml', base: './src/content/articles' }),
	schema: z.object({
		title: z.string(),
		url: z.url(),
		// Blog name, e.g. "Microsoft for Developers".
		publication: z.string(),
		// Publish date. Omit when it can't be confirmed from the article.
		date: z.coerce.date().optional(),
	}),
});

// Talks given about Scope. One YAML file per talk in
// src/content/talks/, named <yyyy-mm-dd>-<event-slug>.yaml.
const talks = defineCollection({
	loader: glob({ pattern: '**/*.yaml', base: './src/content/talks' }),
	schema: z.object({
		title: z.string(),
		speakers: z.array(z.string()).min(1),
		event: z.string(),
		venue: z.string(),
		date: z.coerce.date(),
		eventUrl: z.url(),
		// Omit while the recording is pending; the page shows
		// "Video coming soon" instead of an embed.
		youtubeId: z
			.string()
			.regex(/^[\w-]{11}$/)
			.optional(),
	}),
});

export const collections = {
	docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
	articles,
	talks,
};
