// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { visit } from 'unist-util-visit';

const URL_ATTRIBUTES = new Set(['href', 'src', 'poster']);

export default function remarkBasePath({ base = '/' } = {}) {
	const prefix = `/${base.replace(/^\/+|\/+$/g, '')}`;

	function withBase(url) {
		if (!url.startsWith('/') || url.startsWith('//')) return url;
		const pathname = url.split(/[?#]/, 1)[0];
		if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return url;
		return `${prefix}${url}`;
	}

	return function transformer(tree) {
		if (prefix === '/') return;

		visit(tree, (node) => {
			if (node.type === 'link' || node.type === 'image' || node.type === 'definition') {
				node.url = withBase(node.url);
			}

			// MDX anchors, images, and videos keep literal attributes outside Markdown link nodes.
			if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
				for (const attribute of node.attributes) {
					if (
						attribute.type === 'mdxJsxAttribute' &&
						URL_ATTRIBUTES.has(attribute.name) &&
						typeof attribute.value === 'string'
					) {
						attribute.value = withBase(attribute.value);
					}
				}
			}
		});
	};
}
