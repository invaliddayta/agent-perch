/** Chat markdown: GitHub flavour, raw HTML shown as text, links open in a new tab. */
import { Marked } from "marked";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const marked = new Marked({
	gfm: true,
	breaks: true,
	renderer: {
		html({ text }) {
			return esc(text);
		},
		link({ href, title, tokens }) {
			const inner = this.parser.parseInline(tokens);
			const safe = /^(https?:|mailto:|#|\/)/i.test(href) ? href : "#";
			return `<a href="${esc(safe)}"${title ? ` title="${esc(title)}"` : ""} target="_blank" rel="noopener noreferrer">${inner}</a>`;
		},
		image({ href, text }) {
			return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(text || href)}</a>`;
		},
		table(token) {
			// Wide tables scroll inside the bubble instead of stretching it.
			const head = token.header.map((c) => `<th${c.align ? ` style="text-align:${c.align}"` : ""}>${this.parser.parseInline(c.tokens)}</th>`).join("");
			const rows = token.rows
				.map((r) => `<tr>${r.map((c) => `<td${c.align ? ` style="text-align:${c.align}"` : ""}>${this.parser.parseInline(c.tokens)}</td>`).join("")}</tr>`)
				.join("");
			return `<div class="tbl"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
		},
	},
});

const cache = new Map<string, string>();
export function md(text: string): string {
	let html = cache.get(text);
	if (html === undefined) {
		html = marked.parse(text, { async: false }) as string;
		if (cache.size > 500) cache.clear();
		cache.set(text, html);
	}
	return html;
}
