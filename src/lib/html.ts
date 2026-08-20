/**
 * Kept in its own module so client components can import HTML helpers without
 * dragging node:crypto (via the unsubscribe signer) into the browser bundle.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Turns bare URLs in already-escaped HTML into links.
 *
 * Runs *after* escapeHtml, never before: linkifying first would put an `<a>`
 * into the string that the escape pass would then mangle into visible markup.
 * Shared by the body renderer and the signature renderer so a URL looks the same
 * in both halves of a message.
 */
export function linkifyHtml(html: string): string {
  return html.replace(
    /\bhttps?:\/\/[^\s<]+/g,
    (url) => `<a href="${url}" style="color:#2563eb">${url}</a>`,
  );
}
